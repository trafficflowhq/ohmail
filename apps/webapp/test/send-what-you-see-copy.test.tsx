/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import type { Root } from "react-dom/client";
import { act } from "react";
import { MutationRejectedError, type MutationResult } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { mountWriting, rounds, unmountWritings } from "./_write-1-writing.js";
import { phaseFor, type SendState } from "@ohmail/app-logic/writing/mail-send";

/**
 * WHAT A PERSON IS TOLD WHEN THE DRAFT MOVED UNDER THEIR PRESS.
 *
 * Another window's autosave landed between the last save and Send, so the row is no longer the
 * message on screen and the server refused it. The person is asked to review it — and the words
 * they wrote are still in front of them, because only a CONFIRMATION spends the editor.
 */
let root: Root | null = null;
let host: HTMLElement | null = null;

/*
 * RE-POINTED BY THE OLDER TESTS' SORTING, EXPECTATIONS UNTOUCHED: today's `SendStatus` is drawn by no
 * host. The compose scope's state is drawn where a person reads it now: Write's send line over the new letter
 * (`_write-1-writing.tsx`, as send-status-copy does), in the language on screen; the text read is the send line's
 * (its role, status or alert), nothing else of the sheet.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
void React;

function lineOf(el: HTMLElement): string {
  return [...el.querySelectorAll<HTMLElement>('[role="status"], [role="alert"]')]
    .map((n) => (n.textContent ?? "").trim())
    .filter((text) => text !== "")
    .join(" ");
}

async function render(send: SendState, messages: typeof en | typeof de, locale: string): Promise<string> {
  await unmountWritings();
  host?.remove();
  const world = await mountWriting({ view: true, send, locale: locale === "de" || messages === de ? "de" : "en" });
  host = world.el;
  await rounds(2);
  return lineOf(host);
}

afterEach(async () => {
  act(() => root?.unmount());
  await unmountWritings();
  host?.remove();
  root = null;
  host = null;
});

/** The result the engine really hands `absorb` for this refusal: rolled back, terminal, coded. */
const refused = (): MutationResult => ({
  id: "m1",
  key: "k1",
  status: "rolled_back",
  seq: null,
  error: new MutationRejectedError(
    "This draft changed in another window. Review it before sending.",
    { status: 409, code: "draft_changed", retryable: false },
  ),
});

describe("a draft that moved under the press", () => {
  /**
   * NOT `confirmed`, and that is the whole of "the editor is not cleared": `absorb` runs `settle`
   * — which drops the compose scratch — on a confirmation and on nothing else. A mapping that
   * answered IDLE here would take the words away as well as refusing to send them.
   */
  it("maps to a failed phase carrying the code, never to the confirmation that spends the editor", async () => {
    const state = phaseFor(refused());
    expect(state.phase).toBe("failed");
    expect(state.code).toBe("draft_changed");
    expect(state.phase, "a refusal that reads as a confirmation clears the draft").not.toBe("idle");
  });

  it("says so in English, and does not quote the wire", async () => {
    const text = await render(phaseFor(refused()), en, "en");
    expect(text).toContain("changed in another window");
    expect(text).toContain("review it before sending");
    expect(text, "the send is claimed to have gone").toContain("Not sent");
  });

  it("says so in German", async () => {
    const text = await render(phaseFor(refused()), de, "de");
    expect(text).toContain("in einem anderen Fenster oder auf einem anderen Gerät geändert");
    expect(text).toContain("Nicht gesendet");
  });

  /**
   * The general refusal sentence is the wrong one here: it says sending "didn't work" and points
   * at Send as the retry, and pressing Send again on a row somebody else rewrote is exactly what
   * this refusal exists to stop until the person has looked.
   */
  it("does not fall through to the general failed sentence", async () => {
    const text = await render(phaseFor(refused()), en, "en");
    expect(text).not.toContain("Sending didn't work");
  });
});
