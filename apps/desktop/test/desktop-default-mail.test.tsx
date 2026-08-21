/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  DEFAULT_MAIL_ASKED_KEY,
  DefaultMailAsk,
  DefaultMailRow,
  afterRequestSentence,
  stateValue,
} from "../src/DesktopDefaultMail.js";

/**
 * ═══ THE DEFAULT-MAIL SURFACE — asked once, told the truth always ═══════════════════════════
 *
 * `default_mail_tests.rs` proves the platform table; this file proves the window's half:
 *
 *  · the SETTINGS ROW says what was detected and offers the action only when there is one —
 *    "Make default" over an OS that already says ohmail is a control with nothing to do;
 *  · the FIRST-RUN CARD appears only when another app holds mail links, and NEVER twice: both
 *    answers persist, and "it is already the default" persists too, because a question whose
 *    answer is on screen is a nag;
 *  · an UNKNOWN state asks nothing and claims nothing — a platform we cannot read is not a
 *    platform we get to guess about.
 *
 * ── THE MUTATIONS THESE WERE WATCHED AGAINST ────────────────────────────────────────────────
 *  · stop persisting on "Not now"                → the never-twice case goes red;
 *  · show the card whatever the state            → the already-default and unknown cases go red;
 *  · drop the request wire from the row's button → the row-action case goes red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

let statusAnswer: { state: string };
let requestAnswer: { how: string; state: string } | Error;
let invoked: string[] = [];

beforeEach(() => {
  localStorage.clear();
  invoked = [];
  statusAnswer = { state: "not-default" };
  requestAnswer = { how: "system-dialog", state: "not-default" };
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command) => {
      invoked.push(command);
      if (command === "default_mail_status") return statusAnswer;
      if (command === "default_mail_request") {
        if (requestAnswer instanceof Error) throw requestAnswer;
        return requestAnswer;
      }
      return null;
    },
  };
});

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(node: React.ReactElement): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(node);
  });
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return mountPoint;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
}

afterEach(async () => {
  await unmount();
  delete host.__TAURI_INTERNALS__;
  localStorage.clear();
});

function click(el: Element): Promise<void> {
  return act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
}

function buttonNamed(el: HTMLElement, label: string): Element {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found;
}

describe("the Settings row", () => {
  it("shows the detected state and offers the platform action", async () => {
    const el = await render(h(DefaultMailRow, null));
    expect(el.textContent).toContain("Default mail app");
    expect(el.textContent).toContain("Another app");

    await click(buttonNamed(el, "Make default"));
    expect(invoked).toContain("default_mail_request");
    // The platform's own sentence, from the shell's `how` — never guessed from the user agent.
    expect(el.textContent).toContain("macOS is applying the change — confirm its dialog if one appears.");
  });

  it("offers no action over an OS that already says ohmail", async () => {
    statusAnswer = { state: "default" };
    const el = await render(h(DefaultMailRow, null));
    expect(el.textContent).toContain("ohmail");
    expect([...el.querySelectorAll("button")]).toHaveLength(0);
  });

  it("shows a refusal beside the control, in the shell's words", async () => {
    requestAnswer = new Error("macOS declined the request (Launch Services error -50).");
    const el = await render(h(DefaultMailRow, null));
    await click(buttonNamed(el, "Make default"));
    expect(el.textContent).toContain("macOS declined the request");
  });
});

describe("the one-time ask", () => {
  it("appears when another app holds mail links, and Not now persists", async () => {
    const el = await render(h(DefaultMailAsk, null));
    expect(el.textContent).toContain("Open email links with ohmail?");

    await click(buttonNamed(el, "Not now"));
    expect(el.querySelector("[role='dialog']")).toBeNull();
    expect(localStorage.getItem(DEFAULT_MAIL_ASKED_KEY)).toBe("1");

    // …and never twice: a fresh mount finds the answer and asks nothing.
    await unmount();
    const again = await render(h(DefaultMailAsk, null));
    expect(again.querySelector("[role='dialog']")).toBeNull();
  });

  it("Make default requests, reports the platform's own sentence, and persists", async () => {
    const el = await render(h(DefaultMailAsk, null));
    await click(buttonNamed(el, "Make default"));
    for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });

    expect(invoked).toContain("default_mail_request");
    expect(el.textContent).toContain("macOS is applying the change — confirm its dialog if one appears.");
    expect(localStorage.getItem(DEFAULT_MAIL_ASKED_KEY)).toBe("1");

    await click(buttonNamed(el, "Done"));
    expect(el.querySelector("[role='dialog']")).toBeNull();
  });

  it("asks nothing when ohmail already is the default — and never will again", async () => {
    statusAnswer = { state: "default" };
    const el = await render(h(DefaultMailAsk, null));
    expect(el.querySelector("[role='dialog']")).toBeNull();
    // The answer is the OS's own; it persists so the card cannot appear later either.
    expect(localStorage.getItem(DEFAULT_MAIL_ASKED_KEY)).toBe("1");
  });

  it("asks nothing on a state it cannot read", async () => {
    statusAnswer = { state: "unknown" };
    const el = await render(h(DefaultMailAsk, null));
    expect(el.querySelector("[role='dialog']")).toBeNull();
    // Not persisted: a later launch that CAN read the state may still ask, once.
    expect(localStorage.getItem(DEFAULT_MAIL_ASKED_KEY)).toBeNull();
  });

  it("asks nothing where there is no shell to ask about", async () => {
    delete host.__TAURI_INTERNALS__;
    const el = await render(h(DefaultMailAsk, null));
    expect(el.querySelector("[role='dialog']")).toBeNull();
  });
});

describe("the sentences", () => {
  it("derive from the shell's closed vocabulary, never from the platform", () => {
    expect(afterRequestSentence("system-dialog", "not-default")).toContain("macOS");
    expect(afterRequestSentence("settings-opened", "not-default")).toContain("Windows Settings");
    expect(afterRequestSentence("set", "default")).toContain("open in ohmail now");
    expect(afterRequestSentence("set", "not-default")).toContain("not taken effect");
    expect(afterRequestSentence(null, "not-default")).toBe("The request was sent.");

    expect(stateValue("default")).toBe("ohmail");
    expect(stateValue("not-default")).toBe("Another app");
    expect(stateValue("unknown")).toBe("Not known");
    expect(stateValue(null)).toBe("Checking…");
  });
});
