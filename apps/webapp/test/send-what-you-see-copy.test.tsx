/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { NextIntlClientProvider } from "next-intl";
import { MutationRejectedError, type MutationResult } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { SendStatus } from "../app/shell/SendStatus.js";
import { phaseFor, type SendState } from "../app/shell/mail-send.js";

/**
 * WHAT A PERSON IS TOLD WHEN THE DRAFT MOVED UNDER THEIR PRESS.
 *
 * Another window's autosave landed between the last save and Send, so the row is no longer the
 * message on screen and the server refused it. The person is asked to review it — and the words
 * they wrote are still in front of them, because only a CONFIRMATION spends the editor.
 */
let root: Root | null = null;
let host: HTMLElement | null = null;

function render(send: SendState, messages: typeof en | typeof de, locale: string): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <NextIntlClientProvider locale={locale} messages={messages as never} timeZone="UTC">
        <SendStatus send={send} scope="compose" lane={null} showing={null} />
      </NextIntlClientProvider>,
    );
  });
  return host.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
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
  it("maps to a failed phase carrying the code, never to the confirmation that spends the editor", () => {
    const state = phaseFor(refused());
    expect(state.phase).toBe("failed");
    expect(state.code).toBe("draft_changed");
    expect(state.phase, "a refusal that reads as a confirmation clears the draft").not.toBe("idle");
  });

  it("says so in English, and does not quote the wire", () => {
    const text = render(phaseFor(refused()), en, "en");
    expect(text).toContain("changed in another window");
    expect(text).toContain("review it before sending");
    expect(text, "the send is claimed to have gone").toContain("Not sent");
  });

  it("says so in German", () => {
    const text = render(phaseFor(refused()), de, "de");
    expect(text).toContain("in einem anderen Fenster geändert");
    expect(text).toContain("Nicht gesendet");
  });

  /**
   * The general refusal sentence is the wrong one here: it says sending "didn't work" and points
   * at Send as the retry, and pressing Send again on a row somebody else rewrote is exactly what
   * this refusal exists to stop until the person has looked.
   */
  it("does not fall through to the general failed sentence", () => {
    const text = render(phaseFor(refused()), en, "en");
    expect(text).not.toContain("Sending didn't work");
  });
});
