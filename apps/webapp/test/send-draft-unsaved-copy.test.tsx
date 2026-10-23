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
 * WHAT A PERSON IS TOLD WHEN THIS CLIENT COULD NOT SAVE BEFORE THE PRESS. The save failed, so
 * there is no version of the row to vouch for and the press is refused. Not the same event as
 * another window rewriting the draft, and not that sentence: nobody else wrote here, and
 * "review it before sending" would send the reader looking for a change nobody made.
 *
 * Mutations: the `draft_unsaved` arm removed → both languages and the fall-through; the arm
 * keyed on `draft_changed` → the two "not the other window's sentence" cases.
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

/** The result the adapter really hands `absorb`: rolled back, terminal, coded, no status. */
const refused = (): MutationResult => ({
  id: "m1",
  key: "k1",
  status: "rolled_back",
  seq: null,
  error: new MutationRejectedError(
    "This message was not sent: it could not be saved first, so ohmail cannot tell whether the "
      + "draft is still the one on this screen. Try again.",
    { code: "draft_unsaved", retryable: false },
  ),
});

describe("a press this client could not save first", () => {
  /**
   * NOT `confirmed` — `absorb` spends the compose scratch on a confirmation and on nothing else,
   * so a mapping that answered `idle` here would take the words away as well as refusing to send
   * them. The refusal's whole promise is that the message is still in front of the person.
   */
  it("maps to a failed phase carrying the code, never to the confirmation that spends the editor", () => {
    const state = phaseFor(refused());
    expect({ phase: state.phase, code: state.code }).toEqual({ phase: "failed", code: "draft_unsaved" });
  });

  it("says so in English, without claiming another window wrote anything", () => {
    const text = render(phaseFor(refused()), en, "en");
    expect(text, "the send is claimed to have gone").toContain("Not sent");
    expect(text).toContain("couldn't be saved");
    expect(text, "a change nobody made is announced").not.toContain("another window");
  });

  it("says so in German", () => {
    const text = render(phaseFor(refused()), de, "de");
    expect(text).toContain("Nicht gesendet");
    expect(text).toContain("nicht gespeichert werden");
    expect(text).not.toContain("anderen Fenster");
  });

  /**
   * The general sentence says sending "didn't work" and points at Send as the retry. It is not
   * false here, but it is the wrong one: the reason this press stopped is nameable, and naming
   * it is the difference between a person pressing again blindly and a person saving first.
   */
  it("does not fall through to the general failed sentence", () => {
    expect(render(phaseFor(refused()), en, "en")).not.toContain("Sending didn't work");
  });
});
