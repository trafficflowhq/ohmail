/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DesktopUpdate } from "../src/DesktopUpdate.js";
import {
  reportOfPayload,
  resetUpdateFeedForTests,
  subscriberCountForTests,
  updateButtonKey,
  updateSentenceKey,
  UPDATE_RESULTS,
  UPDATE_STATES,
  type UpdateReport,
} from "../src/update.js";

/**
 * ═══ SETTINGS → UPDATES, EVERY STATE A PERSON CAN MEET ═══════════════════════════════════════
 *
 * The app's own update used to live in one menu-bar item. On a tiling Wayland compositor this app
 * draws no menu bar (`src-tauri/src/frame.rs`), so on those desktops that item was an affordance
 * nobody could reach — which is why the flow now also answers a settings pane.
 *
 * Seven states, each mounted against a stubbed shell and held to the sentence it must say. Two of
 * them share one `Stage` on the Rust side and are DIFFERENT FACTS here: a client that is up to
 * date and one that refused an update whose version it could not confirm. The second is the one
 * that would be our own fault — a release signed without its version stops every client — so a
 * pane that said "up to date" there would be the report that makes nobody look. That pair is the
 * reason this walk exists rather than a single happy-path render.
 *
 * DOUBLES AS THE VISUAL CAPTURE HARNESS, the `desktop-devices-states.test.tsx` precedent: with
 * `OHMAIL_UPDATE_PANE_CAPTURE_DIR` set, each state's rendered markup is written to
 * `<dir>/<name>.html` for `scripts/update-pane-screens.mjs` to wrap in the app's real stylesheets
 * and screenshot. Without the variable this is an ordinary suite member and writes nothing.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const CAPTURE_DIR = process.env.OHMAIL_UPDATE_PANE_CAPTURE_DIR;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const globe = globalThis as unknown as {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback: (cb: (p: unknown) => void) => number };
};

const copy = (en as { update: Record<string, string> }).update;

/** The shell's own answer shape — the JSON `updater.rs`'s `report` builds, spelled as it lands. */
type Wire = Record<string, unknown>;

const VERSION = "0.13.4";
const NEXT = "0.13.5";
const CHECKED_AT = Date.parse("2026-09-02T00:00:00Z");

const WIRE: Record<string, Wire> = {
  // A window that has not seen a check finish. NOT the same as up to date, and it must not
  // borrow that sentence: nothing has asked the feed yet.
  neverChecked: {
    version: VERSION, state: "idle", offered: null,
    canCheck: true, canInstall: false, lastCheckedAt: null, lastResult: "never",
  },
  upToDate: {
    version: VERSION, state: "idle", offered: null,
    canCheck: true, canInstall: false, lastCheckedAt: CHECKED_AT, lastResult: "upToDate",
  },
  checking: {
    version: VERSION, state: "checking", offered: null,
    canCheck: false, canInstall: false, lastCheckedAt: CHECKED_AT, lastResult: "upToDate",
  },
  downloading: {
    version: VERSION, state: "downloading", offered: NEXT,
    canCheck: false, canInstall: false, lastCheckedAt: CHECKED_AT, lastResult: "offered",
  },
  ready: {
    version: VERSION, state: "ready", offered: NEXT,
    canCheck: false, canInstall: true, lastCheckedAt: CHECKED_AT, lastResult: "offered",
  },
  failed: {
    version: VERSION, state: "failed", offered: null,
    canCheck: true, canInstall: false, lastCheckedAt: CHECKED_AT, lastResult: "failed",
  },
  // THE ONE THE MENU ITEM CANNOT SAY. An update exists, this client will not install it, and the
  // version on disk is unchanged — three facts, none of them "you are up to date".
  refused: {
    version: VERSION, state: "idle", offered: null,
    canCheck: true, canInstall: false, lastCheckedAt: CHECKED_AT, lastResult: "refused",
  },
};

let pressed = 0;
let listens = 0;
let listener: ((payload: unknown) => void) | null = null;
/** What `update_state` answers next — swapped mid-test to model the shell moving on. */
let answer: Wire | null = null;
/** When true, `update_press` REJECTS, the way an older shell without the command would. */
let refusePress = false;

/** A shell that answers `state` and records presses. `null` = no shell at all (the preview). */
function shell(state: Wire | null): void {
  pressed = 0;
  listens = 0;
  listener = null;
  refusePress = false;
  answer = state;
  resetUpdateFeedForTests();
  if (state === null) {
    delete globe.__TAURI_INTERNALS__;
    return;
  }
  globe.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      switch (command) {
        case "update_state":
          return Promise.resolve(answer);
        case "update_press":
          pressed += 1;
          return refusePress
            ? Promise.reject(new Error("no such command"))
            : Promise.resolve(undefined);
        case "plugin:event|listen":
          // The runtime hands back a callback ID; the test keeps the callback itself so a push
          // can be delivered the way the shell delivers one — and COUNTS the registrations,
          // which is the whole of the leak guard below.
          listens += 1;
          void (payload as { event: string });
          return Promise.resolve(1);
        default:
          return Promise.resolve(undefined);
      }
    },
    transformCallback: (cb) => {
      listener = cb;
      return 1;
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  hostEl?.remove();
  delete globe.__TAURI_INTERNALS__;
  resetUpdateFeedForTests();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(locale: "en" | "de" = "en"): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(
        NextIntlClientProvider,
        { locale, messages: (locale === "en" ? en : de) as never, timeZone: "Europe/Zurich" },
        h(ThemeProvider, null, h(DesktopUpdate)),
      ),
    );
  });
  await settle();
}

const button = (): HTMLButtonElement | null => hostEl.querySelector("button");

const click = async (): Promise<void> => {
  await act(async () => {
    button()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
};

async function unmount(): Promise<void> {
  await act(async () => root.unmount());
  hostEl.remove();
}

function capture(name: string): void {
  if (!CAPTURE_DIR) return;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, `${name}.html`), hostEl.innerHTML);
}

// ═══ THE SEVEN STATES ═════════════════════════════════════════════════════════════════════════

describe("every state the update pane can be in renders, and says the true thing", () => {
  it("1 — no check has finished yet: it says so, and does not claim currency", async () => {
    shell(WIRE.neverChecked!);
    await mount();
    expect(hostEl.textContent).toContain(copy.subhead!);
    expect(hostEl.textContent).toContain(`ohmail ${VERSION}`);
    expect(hostEl.textContent).toContain(copy.neverChecked!);
    // The sentence that would be a claim about a feed nobody has asked yet.
    expect(hostEl.textContent).not.toContain("is the newest release");
    expect(button()!.textContent).toBe(copy.check!);
    expect(button()!.disabled).toBe(false);
    capture("1-never-checked");
  });

  it("2 — up to date: the version, and when it was established", async () => {
    shell(WIRE.upToDate!);
    await mount();
    expect(hostEl.textContent).toContain(`ohmail ${VERSION} is the newest release.`);
    expect(hostEl.textContent).toMatch(/Checked /);
    expect(button()!.textContent).toBe(copy.check!);
    capture("2-up-to-date");
  });

  it("3 — checking: the button cannot be pressed again", async () => {
    shell(WIRE.checking!);
    await mount();
    expect(hostEl.textContent).toContain(copy.checking!);
    // Disabled rather than absent: a control that vanishes mid-press reads as a crash, and one
    // that stays live and does nothing is worse than one that is visibly busy.
    expect(button()!.disabled).toBe(true);
    capture("3-checking");
  });

  it("4 — downloading: it names the version, and says nothing installs yet", async () => {
    shell(WIRE.downloading!);
    await mount();
    expect(hostEl.textContent).toContain(`Downloading ohmail ${NEXT}`);
    expect(hostEl.textContent).toContain("Nothing is installed until you agree");
    expect(button()!.disabled).toBe(true);
    capture("4-downloading");
  });

  it("5 — ready: the press restarts, and the button says which", async () => {
    shell(WIRE.ready!);
    await mount();
    expect(hostEl.textContent).toContain(`ohmail ${NEXT} is ready`);
    expect(button()!.textContent).toBe(copy.restart!);
    expect(button()!.disabled).toBe(false);
    capture("5-ready");
  });

  it("6 — failed: one plain sentence and a way to try again", async () => {
    shell(WIRE.failed!);
    await mount();
    expect(hostEl.textContent).toContain(copy.failed!);
    // No library error text anywhere near it — the shell's own rule, kept on this surface too.
    expect(hostEl.textContent).not.toMatch(/error sending request|dns error|ENOTFOUND/);
    expect(button()!.textContent).toBe(copy.check!);
    expect(button()!.disabled).toBe(false);
    capture("6-failed");
  });

  /**
   * THE STATE THIS PANE EXISTS TO BE ABLE TO SAY.
   *
   * A refusal about a payload's IDENTITY and an up-to-date client are the same `Stage::Idle` on
   * the Rust side. Saying "up to date" here would be untrue — an update exists and this client
   * will not install it — and it would hide the shape of this that is our own fault.
   */
  it("7 — refused: it says an update exists and was not installed, not that you are current", async () => {
    shell(WIRE.refused!);
    await mount();
    expect(hostEl.textContent).toContain("could not confirm which version");
    expect(hostEl.textContent).toContain("The version you have is unchanged");
    expect(hostEl.textContent).not.toContain("is the newest release");
    capture("7-refused");
  });

  /**
   * AND THE EIGHTH, WHICH IS NOTHING AT ALL. Outside the app — a development server, the render
   * check, the interface-preview build whose window is granted no command — the pane draws
   * nothing rather than an update control with nothing behind it.
   */
  it("8 — no shell: it renders nothing rather than a control that cannot work", async () => {
    shell(null);
    await mount();
    expect(hostEl.textContent).toBe("");
    expect(button()).toBeNull();
  });
});

// ═══ WHAT PRESSING DOES, AND WHAT ARRIVES BACK ════════════════════════════════════════════════

describe("the pane is the same flow as the menu item, not a second one", () => {
  it("a press goes to the shell once, and the pane then shows what the shell says now", async () => {
    shell(WIRE.upToDate!);
    await mount();
    // The shell takes the press and moves; the pane re-reads and reports the new state.
    answer = WIRE.checking!;
    await click();
    expect(pressed).toBe(1);
    expect(hostEl.textContent).toContain(copy.checking!);
    expect(button()!.disabled).toBe(true);
  });

  it("a pushed state replaces what the pane shows, and un-busies the button", async () => {
    shell(WIRE.upToDate!);
    await mount();
    expect(listener, "the pane never registered a listener").not.toBeNull();

    // The shell announces the transition, in the envelope its event plugin wraps payloads in.
    await act(async () => listener!({ payload: WIRE.ready }));
    await settle();
    expect(hostEl.textContent).toContain(`ohmail ${NEXT} is ready`);
    expect(button()!.textContent).toBe(copy.restart!);
    expect(button()!.disabled).toBe(false);
  });

  it("a disabled button cannot press", async () => {
    shell(WIRE.checking!);
    await mount();
    expect(button()!.disabled).toBe(true);
    await click();
    expect(pressed).toBe(0);
  });

  /**
   * A PRESS THE SHELL REFUSES MUST NOT STRAND THE BUTTON.
   *
   * The click marks the control busy, and the outcome of a press normally arrives on the event —
   * so an invoke that REJECTS (an older shell, a grant that dropped the command) produces no event
   * at all, and a pane that only cleared `busy` on a state change would sit on "Working…" until it
   * was closed and reopened. On the one surface whose job is to tell somebody whether their mail
   * client is current, that is the control going dead. The press therefore always finishes by
   * asking the shell where the flow is, which answers this case and the `Press::Nothing` race with
   * one mechanism.
   */
  it("survives a press the shell refuses, and is pressable again afterwards", async () => {
    shell(WIRE.upToDate!);
    await mount();
    refusePress = true;
    await click();
    expect(pressed).toBe(1);
    expect(button()!.disabled, "the button is stuck busy after a refused press").toBe(false);
    expect(button()!.textContent).toBe(copy.check!);
    // …and it really is live: a second press reaches the shell.
    refusePress = false;
    await click();
    expect(pressed).toBe(2);
  });

  /**
   * …AND A PRESS THAT CHANGED NOTHING MUST NOT EITHER. `Flow::press` answers `Nothing` for a press
   * that raced the flow moving under it: the shell takes the call, does nothing, and announces
   * nothing. Modelled here by a shell that accepts the press and answers the same state.
   */
  it("survives a press that changed nothing", async () => {
    shell(WIRE.upToDate!);
    await mount();
    await click();
    expect(pressed).toBe(1);
    expect(button()!.disabled).toBe(false);
    expect(button()!.textContent).toBe(copy.check!);
  });
});

/**
 * ═══ THE PANE IS OPENED AND CLOSED AS OFTEN AS SOMEBODY LIKES ════════════════════════════════
 *
 * Settings → About is not a screen that mounts once. `plugin:event|listen` has no unlisten on this
 * seam, so a registration per mount would hand the shell a new callback every visit and keep every
 * previous mount's closure alive — each one called on every transition, for the life of the
 * process. The registration is therefore the module's, made once; the component's subscription is
 * an ordinary one it releases on unmount.
 */
describe("revisiting the pane does not accumulate listeners", () => {
  it("registers with the shell exactly once, however many times the pane is opened", async () => {
    shell(WIRE.upToDate!);
    await mount();
    expect(listens, "the pane never asked the shell to listen").toBe(1);

    for (let visit = 0; visit < 3; visit++) {
      await unmount();
      await mount();
    }
    expect(listens, "the pane registers a new shell listener on every visit").toBe(1);
  });

  /**
   * A CLOSED PANE LETS GO — asserted on the SUBSCRIBER COUNT and not on what is on screen.
   *
   * The rendered-markup version of this test is VACUOUS and was watched being so: a leaked
   * subscriber from a closed pane still runs on every transition, and simply does nothing visible
   * because the component guards its setter with a mounted flag. Removing the release left the
   * DOM assertion green. The count is the fact the release is about.
   */
  it("a closed pane lets go of its subscription, and the open one keeps hearing", async () => {
    shell(WIRE.upToDate!);
    expect(subscriberCountForTests()).toBe(0);
    await mount();
    expect(subscriberCountForTests(), "the pane never subscribed").toBe(1);

    await unmount();
    expect(subscriberCountForTests(), "a closed pane is still subscribed").toBe(0);

    for (let visit = 0; visit < 3; visit++) {
      await mount();
      await unmount();
    }
    expect(subscriberCountForTests(), "subscriptions accumulate across visits").toBe(0);

    // …and the pane that IS open still hears the shell.
    await mount();
    await act(async () => listener!({ payload: WIRE.ready }));
    await settle();
    expect(hostEl.textContent).toContain(`ohmail ${NEXT} is ready`);
    expect(subscriberCountForTests()).toBe(1);
  });
});

// ═══ THE COPY IS TRANSLATED, AND THE PANE READS THE TRANSLATION ═══════════════════════════════

describe("the pane speaks the reader's language", () => {
  it("renders German copy under a German locale", async () => {
    shell(WIRE.refused!);
    await mount("de");
    const german = (de as { update: Record<string, string> }).update;
    expect(hostEl.textContent).toContain(german.refused!);
    expect(button()!.textContent).toBe(german.check!);
    // ANTI-VACUITY: the German sentence is not the English one.
    expect(german.refused).not.toBe(copy.refused);
  });
});

// ═══ THE PARSER AND THE TWO PURE MAPPINGS ═════════════════════════════════════════════════════

describe("what the window will accept from a shell that may be a version ahead", () => {
  const good = WIRE.upToDate!;

  it("takes the value itself and the event envelope alike", () => {
    expect(reportOfPayload(good)?.version).toBe(VERSION);
    expect(reportOfPayload({ payload: good })?.version).toBe(VERSION);
  });

  it("refuses a payload with no version — the one field with no honest fallback", () => {
    for (const junk of [null, undefined, 7, "0.13.4", {}, { version: "" }, { version: "  " }, { version: 3 }]) {
      expect(reportOfPayload(junk), `${JSON.stringify(junk)} became a report`).toBeNull();
    }
  });

  it("degrades an unknown state and an unknown result instead of throwing", () => {
    const ahead = reportOfPayload({ ...good, state: "reticulating", lastResult: "vibes" })!;
    expect(ahead.state).toBe("unknown");
    expect(ahead.lastResult).toBe("never");
    // …and the pane still has something true to draw from it.
    expect(ahead.version).toBe(VERSION);
    expect(updateSentenceKey(ahead)).toBe("unchecked");
  });

  it("treats a missing or non-boolean permission as NO permission", () => {
    const loose = reportOfPayload({ ...good, canCheck: "yes", canInstall: 1 })!;
    expect(loose.canCheck).toBe(false);
    expect(loose.canInstall).toBe(false);
    expect(updateButtonKey(loose)).toBeNull();
  });

  it("keeps a timestamp only when it is a real number", () => {
    expect(reportOfPayload({ ...good, lastCheckedAt: CHECKED_AT })!.lastCheckedAt).toBe(CHECKED_AT);
    for (const junk of [null, "now", Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(reportOfPayload({ ...good, lastCheckedAt: junk })!.lastCheckedAt).toBeNull();
    }
  });
});

describe("the two pure mappings", () => {
  const base = reportOfPayload(WIRE.upToDate!)!;

  it("every state and every result has a key, and every key has copy in both languages", () => {
    const keys = new Set<string>();
    for (const state of UPDATE_STATES) {
      for (const lastResult of UPDATE_RESULTS) {
        keys.add(updateSentenceKey({ ...base, state, lastResult } as UpdateReport));
      }
    }
    keys.add("check");
    keys.add("restart");
    keys.add("working");
    keys.add("subhead");
    keys.add("label");
    keys.add("lastChecked");
    keys.add("neverChecked");
    // Nothing invented and nothing missing: the pane can address every key it can compute, in
    // both catalogues. A key with no copy renders as the raw key on the one control that tells
    // somebody whether their mail client is current.
    for (const key of keys) {
      expect(copy, `en.json has no update.${key}`).toHaveProperty(key);
      expect((de as { update: Record<string, string> }).update, `de.json has no update.${key}`)
        .toHaveProperty(key);
    }
  });

  it("what is HAPPENING beats what last happened", () => {
    // A check running now is more useful than "checked two minutes ago", and a payload waiting is
    // more useful than either — so the in-flight states win over every last result.
    for (const lastResult of UPDATE_RESULTS) {
      expect(updateSentenceKey({ ...base, state: "checking", lastResult })).toBe("checking");
      expect(updateSentenceKey({ ...base, state: "downloading", lastResult })).toBe("downloading");
      expect(updateSentenceKey({ ...base, state: "ready", lastResult })).toBe("ready");
      expect(updateSentenceKey({ ...base, state: "failed", lastResult })).toBe("failed");
    }
  });

  it("with nothing in flight, the last result is what there is to say", () => {
    const quiet = (lastResult: UpdateReport["lastResult"]) =>
      updateSentenceKey({ ...base, state: "idle", lastResult });
    expect(quiet("upToDate")).toBe("upToDate");
    expect(quiet("refused")).toBe("refused");
    expect(quiet("failed")).toBe("failed");
    expect(quiet("never")).toBe("unchecked");
    // `offered` with nothing in flight is a payload that was deferred or a download that ended.
    // There is nothing true to claim about currency, so it does not claim any.
    expect(quiet("offered")).toBe("unchecked");
    // A state this bundle cannot name still has a true last result to report.
    expect(updateSentenceKey({ ...base, state: "unknown", lastResult: "refused" })).toBe("refused");
  });

  it("the button offers exactly what the shell permits, and nothing when it permits nothing", () => {
    expect(updateButtonKey({ ...base, canCheck: true, canInstall: false })).toBe("check");
    expect(updateButtonKey({ ...base, canCheck: false, canInstall: true })).toBe("restart");
    expect(updateButtonKey({ ...base, canCheck: false, canInstall: false })).toBeNull();
    // Install wins if a shell ever answered both: restarting into a verified payload is the more
    // specific act, and re-checking would replace a download that is already done.
    expect(updateButtonKey({ ...base, canCheck: true, canInstall: true })).toBe("restart");
  });
});
