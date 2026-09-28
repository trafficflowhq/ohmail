/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { DOOR_COPY } from "../src/door-copy.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";

/**
 * THE FAILED-ENGINE CARD'S PRESS RESTARTS THE ENGINE. Its "Try again" re-read the status of an
 * engine the shell had given up on, so the same card came back and only quitting helped. The
 * REAL gate over a mocked shell: a given-up engine's press reaches `engine_retry`; a card with
 * nothing to restart says "Read again" and only re-reads.
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

/** The give-up sentence with a structured start line in it: a class that is not the lock or the store. */
const CLASSED_REASON =
  "the engine failed 4 starts in a row, so the shell stopped restarting it. " +
  'The last error it reported was: {"ts":"2026-09-28T05:00:00.000Z","level":"error",' +
  '"service":"sidecar","event":"start_failed","errorClass":"MigrationError"} — quit ohmail and ' +
  "open it again once that is fixed.";
/** …and the one with no class at all. */
const BARE_REASON =
  "the engine failed 4 starts in a row, so the shell stopped restarting it, and it wrote nothing " +
  "that named a cause — ohmail's log file has its full output.";

/** The shell's recovery presses: a read-only card sends none of them. */
const RECOVERY = ["engine_retry", "engine_unlock_retry", "engine_start_over", "engine_configure"];

/** A shell in `status`; `engine_retry` restarts it unless `refuse` names the shell's refusal. */
function fakeShell(first: EngineStatus | "unreachable", refuse?: string): { commands: string[] } {
  const ledger = { commands: [] as string[] };
  let status = first;
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command) => {
      ledger.commands.push(command);
      if (command === "engine_status") {
        if (status === "unreachable") throw new Error("ohmail Desktop: the shell is not answering.");
        return status;
      }
      if (command === "engine_retry") {
        if (refuse !== undefined) throw refuse;
        status = { state: "starting", mode: "local" } as EngineStatus;
        return status;
      }
      return null;
    },
  };
  return ledger;
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

/* Typed loosely ON PURPOSE, as in `desktop-gate-start-over.test.tsx`. */
type Loose = (props: Record<string, unknown>, ...children: unknown[]) => React.ReactElement;
const Intl = IntlProvider as unknown as Loose;
const looseH = h as unknown as (c: Loose, p: Record<string, unknown> | null, ...k: unknown[]) => React.ReactElement;
const Theme = ThemeProvider as unknown as Loose;
const Toast = ToastHost as unknown as Loose;

const settle = async (turns: number): Promise<void> => {
  for (let i = 0; i < turns; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
};

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
  await settle(20);
  return mountPoint;
}

/** The card's one press, whatever it is labelled. */
async function pressTheOneButton(el: HTMLElement): Promise<string> {
  const buttons = [...el.querySelectorAll("button")];
  expect(buttons, "the card offers exactly one press").toHaveLength(1);
  const label = buttons[0]!.textContent ?? "";
  await act(async () => {
    buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(10);
  return label;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
});

describe("the failed-engine card restarts an engine the shell gave up on", () => {
  for (const [name, reason] of [["a class the card has no own sentence for", CLASSED_REASON], ["no class at all", BARE_REASON]] as const) {
    it(`with ${name}, the press reaches the restart and the card leaves`, async () => {
      const ledger = fakeShell({ state: "failed", mode: "local", reason } as EngineStatus);
      const el = await render();
      expect(el.textContent ?? "").toContain(DOOR_COPY.gateCannotOpen);
      const label = await pressTheOneButton(el);
      expect(label).toBe(DOOR_COPY.gateTryAgain);
      expect(ledger.commands.filter((c) => c === "engine_retry"), "the press never asked for a restart").toHaveLength(1);
      expect(el.textContent ?? "", "the engine is starting again, so the card is gone").not.toContain(DOOR_COPY.gateCannotOpen);
    });
  }

  it("a refused restart says so, and the card stays", async () => {
    fakeShell({ state: "failed", mode: "local", reason: CLASSED_REASON } as EngineStatus,
      "this install has no engine to start; nothing was restarted");
    const el = await render();
    await pressTheOneButton(el);
    expect(el.textContent ?? "").toContain(DOOR_COPY.gateRetryRefused);
    expect(el.textContent ?? "").toContain(DOOR_COPY.gateCannotOpen);
  });
});

describe("a card with nothing to restart says Read again, and only reads", () => {
  it("an engine this build does not carry", async () => {
    const ledger = fakeShell({ state: "absent", mode: "local" } as EngineStatus);
    const el = await render();
    const asked = ledger.commands.filter((c) => c === "engine_status").length;
    expect(await pressTheOneButton(el)).toBe(DOOR_COPY.gateReadAgain);
    expect(ledger.commands.filter((c) => RECOVERY.includes(c)), "a read-only press asked for a recovery").toEqual([]);
    expect(ledger.commands.filter((c) => c === "engine_status").length).toBeGreaterThan(asked);
  });

  it("a shell that did not answer", async () => {
    const ledger = fakeShell("unreachable");
    const el = await render();
    expect(await pressTheOneButton(el)).toBe(DOOR_COPY.gateReadAgain);
    expect(ledger.commands.filter((c) => RECOVERY.includes(c))).toEqual([]);
  });
});
