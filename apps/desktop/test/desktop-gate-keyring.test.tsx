/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { DOOR_COPY, keyringSentence } from "../src/door-copy.js";
import { gateFor } from "../src/doors.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";

/**
 * ═══ A KEY STORE THAT WILL NOT ANSWER IS SAID IN A PERSON'S WORDS ═══════════════════════════
 *
 * A fresh install on a Linux desktop with no usable login keyring opened to "ohmail cannot open
 * your mailbox" before any mailbox was chosen, with the library's own error in the sentence
 * ("Couldn't access platform storage: SS error: …") and a Try again that re-read the same answer.
 * The card names the keyring and says what to do. Its Try again (KEYRING-CARD-HAS-NO-RETRY) now
 * reads the store again — `Shell::retry` re-plans from `NoKey` — so a press after unlocking opens
 * the door, and a store still locked says so under the button.
 *
 * Mutations watched red: `gateFor` without `keyring: true` (the old card and its raw reason come
 * back); the card's `keyring` arm deleted from `DesktopGate`; `keyringSentence` answering the
 * keychain sentence on Linux; the still-locked reading dropped from the card.
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

/** The shell's own sentence, with the keyring library's error quoted inside it. */
const RAW_NO_KEY =
  "this computer's keystore would not store a key (Couldn't access platform storage: SS error: " +
  "result not returned from SS API)";

/** A shell whose key store refuses until `retries` presses in, then the engine serves. */
function noKeyShell(opensAfter = Number.POSITIVE_INFINITY): { commands: string[] } {
  const ledger = { commands: [] as string[] };
  const noKey = { state: "no_key", mode: null, reason: RAW_NO_KEY } as unknown as EngineStatus;
  let status: EngineStatus = noKey;
  let presses = 0;
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command) => {
      ledger.commands.push(command);
      if (command === "engine_retry") {
        presses += 1;
        if (presses >= opensAfter) status = { state: "starting", mode: "local", attempt: 1, of: 4 } as unknown as EngineStatus;
        return status;
      }
      if (command === "engine_status") return status;
      return null;
    },
  };
  return ledger;
}

type Loose = (props: Record<string, unknown>, ...children: unknown[]) => React.ReactElement;
const Intl = IntlProvider as unknown as Loose;
const looseH = h as unknown as (c: Loose, p: Record<string, unknown> | null, ...k: unknown[]) => React.ReactElement;
const Theme = ThemeProvider as unknown as Loose;
const Toast = ToastHost as unknown as Loose;

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      looseH(
        Intl,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        looseH(Theme, { storageKey: "ohmail.theme" }, looseH(Toast, null, h(DesktopGate, null))),
      ),
    );
  });
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return mountPoint;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
});

describe("the key store's card", () => {
  it("names the keyring and the remedy, and the library's error reaches nobody", async () => {
    noKeyShell();
    const el = await render();
    const said = el.textContent ?? "";
    expect(said).toContain(DOOR_COPY.gateKeyringTitle);
    expect(said).toContain(DOOR_COPY.gateKeyringWhy);
    expect(said, "a mailbox was spoken of before one was chosen").not.toContain(DOOR_COPY.gateCannotOpen);
    expect(said, "the keyring library's own error reached the person").not.toContain("SS error");
    expect(said).not.toContain("platform storage");
  });

  it("Try again asks the store again, and a store still locked says so under the button", async () => {
    const ledger = noKeyShell();
    const el = await render();
    const again = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "") === DOOR_COPY.gateTryAgain);
    expect(again, "the keyring card offers no press that reads the store again").toHaveLength(1);
    await act(async () => { again[0]!.click(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(ledger.commands).toContain("engine_retry");
    const alerts = [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts, "a store still locked was silent").toEqual([DOOR_COPY.gateKeyringStillLocked]);
    expect(el.textContent).toContain(DOOR_COPY.gateKeyringTitle);
  });

  it("a press after the store answers leaves the card", async () => {
    noKeyShell(1);
    const el = await render();
    const again = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "") === DOOR_COPY.gateTryAgain)!;
    await act(async () => { again.click(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(el.textContent, "the card stayed over an engine the store now opens").not.toContain(DOOR_COPY.gateKeyringTitle);
    expect(el.textContent).not.toContain(DOOR_COPY.gateKeyringStillLocked);
  });

  it("the gate still carries the shell's reason, for the log, beside the keyring mark", () => {
    const gate = gateFor({ kind: "status", status: { state: "no_key", mode: null, reason: RAW_NO_KEY } as unknown as EngineStatus });
    expect(gate).toEqual({ kind: "notice", reason: RAW_NO_KEY, keyring: true });
  });

  it("names this platform's store", () => {
    expect(keyringSentence("linux")).toBe(DOOR_COPY.gateKeyringWhy);
    expect(keyringSentence("darwin")).toBe(DOOR_COPY.gateKeychainWhy);
    expect(keyringSentence("win32")).toBe(DOOR_COPY.gateCredentialsWhy);
    expect(DOOR_COPY.gateKeyringWhy).toContain("login keyring");
  });
});
