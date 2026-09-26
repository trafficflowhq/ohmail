/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DesktopGate } from "../src/DesktopGate.js";
import { DOOR_COPY } from "../src/door-copy.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";

/**
 * A STORE THE ENGINE CANNOT OPEN GETS ONE PRESS THAT WORKS. The card used to say "quit ohmail and
 * open it again" over a half-made store every later start failed on, and its Try again only
 * re-read the status. This drives the REAL gate with a mocked shell: the class the sidecar names
 * in its start line picks the card, and the press reaches `engine_start_over` and re-reads.
 */

/* @reads: apps/desktop/src-tauri/src/engine.rs apps/sidecar/src/db.ts
   Read by a path built at runtime, so no landing pass selects this file when that source
   moves — the shape `reads-list.mjs` exists for. */

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

/** The give-up sentence as the shell composed it over a store a kill left half made. */
const RAW_STORE_REASON =
  "the engine failed 4 starts in a row, so the shell stopped restarting it. " +
  'The last error it reported was: {"ts":"2026-09-26T08:41:01.541Z","level":"error",' +
  '"service":"sidecar","event":"start_failed","errorClass":"LocalStoreOpenError",' +
  '"errorCode":"42P01"} — quit ohmail and open it again once that is fixed.';

/** A shell whose engine gave up on its store; `refuse` makes the press fail as a move would. */
function fakeFailedShell(refuse = false): { commands: string[] } {
  const ledger = { commands: [] as string[] };
  let status: EngineStatus = { state: "failed", mode: "local", reason: RAW_STORE_REASON } as EngineStatus;
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command) => {
      ledger.commands.push(command);
      if (command === "engine_status") return status;
      if (command === "engine_start_over") {
        if (refuse) throw "the store could not be moved aside (Permission denied); the engine was not restarted";
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

/* Typed loosely ON PURPOSE, as in `desktop-gate-locked.test.tsx`: the providers' overloads reject
   this mounting shape under the test-dirs ratchet. */
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

const buttonNamed = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "") === label);

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
});

describe("the card for a store the engine cannot open", () => {
  it("says what happened, offers Start over alone, and never tells the person to quit", async () => {
    fakeFailedShell();
    const el = await render();
    const said = el.textContent ?? "";
    expect(said).toContain(DOOR_COPY.gateCannotOpen);
    expect(said).toContain(DOOR_COPY.gateStoreUnopenable);
    expect(said).toContain(DOOR_COPY.gateFoot);
    expect(said, "quitting reruns the same open, so the card must not suggest it").not.toMatch(/quit/i);
    expect(said).not.toContain('{"ts"');
    expect(buttonNamed(el, DOOR_COPY.gateStartOver)).toHaveLength(1);
    expect(el.querySelectorAll("button"), "one way out, not a second press that does nothing").toHaveLength(1);
  });

  it("the press asks the shell to start over and re-reads the state", async () => {
    const ledger = fakeFailedShell();
    const el = await render();
    const asked = ledger.commands.filter((c) => c === "engine_status").length;
    await act(async () => {
      buttonNamed(el, DOOR_COPY.gateStartOver)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(10);
    expect(ledger.commands.filter((c) => c === "engine_start_over"), "the press never reached the shell").toHaveLength(1);
    expect(ledger.commands.filter((c) => c === "engine_status").length).toBeGreaterThan(asked);
    expect(el.textContent ?? "").not.toContain(DOOR_COPY.gateStoreUnopenable);
  });

  it("a refused press says so, and the card stays", async () => {
    fakeFailedShell(true);
    const el = await render();
    await act(async () => {
      buttonNamed(el, DOOR_COPY.gateStartOver)[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(10);
    expect(el.textContent ?? "").toContain(DOOR_COPY.gateStartOverRefused);
    expect(el.textContent ?? "").toContain(DOOR_COPY.gateStoreUnopenable);
  });
});

describe("the two spellings of the store's names are one", () => {
  /**
   * The shell moves `<dataDir>/pgdata` into `set-aside-<stamp>/`; the sidecar makes the one and
   * uses the same prefix when it sets an unfinished store aside itself; the window reads the
   * sidecar's class name out of the start line. Three literals in two languages, read here.
   */
  it("the Rust mover, the sidecar and the window name the same things", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rust = fs.readFileSync(path.resolve(here, "../src-tauri/src/engine.rs"), "utf8");
    const sidecar = fs.readFileSync(path.resolve(here, "../../sidecar/src/db.ts"), "utf8");
    const gate = fs.readFileSync(path.resolve(here, "../src/DesktopGate.tsx"), "utf8");
    expect(rust).toContain('pub(crate) const STORE_DIR_NAME: &str = "pgdata";');
    expect(sidecar).toContain('export const PGDATA_SUBDIR = "pgdata";');
    expect(rust).toContain('pub(crate) const SET_ASIDE_PREFIX: &str = "set-aside-";');
    expect(sidecar).toContain('export const SET_ASIDE_PREFIX = "set-aside-";');
    expect(sidecar).toContain('this.name = "LocalStoreOpenError";');
    expect(gate).toContain('gate.failureClass === "LocalStoreOpenError"');
  });
});
