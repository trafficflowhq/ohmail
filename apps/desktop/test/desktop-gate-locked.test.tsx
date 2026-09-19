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
import { failureClassOf, gateFor } from "../src/doors.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";

/**
 * ═══ A STRUCTURED START FAILURE RENDERS A PERSON'S SENTENCE, NEVER THE LOG LINE ═════════════
 *
 * Measured on the Windows guest: the "cannot open your mailbox" card rendered
 * `{"ts":…,"errorClass":"DataDirLockedError","errorCode":null}` between a good headline and a
 * good reassurance — the shell quotes the engine's last stderr line verbatim into its give-up
 * sentence, and for a structured line that quote is a developer object. And the state it
 * described was PERMANENT: the card's own advice ("quit ohmail and open it again") cannot clear
 * a lock whose recorded owner cannot be judged, so the card must also carry the one press that
 * acts — "Unlock and retry", the shell command that removes the lock and re-enters start.
 *
 * This file drives the REAL gate with a mocked shell: the raw reason goes in, the clause and the
 * press must come out, and the raw object must reach nobody.
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

/** The give-up sentence the shell composes, with the sidecar's own log line quoted inside it. */
const RAW_LOCKED_REASON =
  "the engine failed 4 starts in a row, so the shell stopped restarting it. " +
  'The last error it reported was: {"ts":"2026-09-19T07:36:29.474Z","level":"error",' +
  '"service":"sidecar","event":"start_failed","errorClass":"DataDirLockedError",' +
  '"errorCode":null} — quit ohmail and open it again once that is fixed.';

const RAW_OTHER_REASON =
  "the engine failed 4 starts in a row, so the shell stopped restarting it. " +
  'The last error it reported was: {"ts":"2026-09-19T07:36:29.474Z","level":"error",' +
  '"service":"sidecar","event":"start_failed","errorClass":"SomethingElseError",' +
  '"errorCode":null} — quit ohmail and open it again once that is fixed.';

describe("the failure class is read out of the shell's sentence", () => {
  it("finds the sidecar's errorClass inside the quoted log line", () => {
    expect(failureClassOf(RAW_LOCKED_REASON)).toBe("DataDirLockedError");
    expect(failureClassOf(RAW_OTHER_REASON)).toBe("SomethingElseError");
  });

  it("a plain sentence carries no class, and its reason travels untouched", () => {
    expect(failureClassOf("Error: EISDIR: illegal operation on a directory, lstat 'C:'")).toBe(null);
    const gate = gateFor({
      kind: "status",
      status: { state: "failed", mode: "local", reason: "another copy is running" } as EngineStatus,
    });
    expect(gate).toEqual({ kind: "notice", reason: "another copy is running" });
  });

  it("the failed gate carries the class beside the raw reason", () => {
    const gate = gateFor({
      kind: "status",
      status: { state: "failed", mode: "local", reason: RAW_LOCKED_REASON } as EngineStatus,
    });
    expect(gate.kind).toBe("notice");
    expect((gate as { failureClass?: string }).failureClass).toBe("DataDirLockedError");
  });
});

/** A shell whose engine has given up on the lock, and a ledger of every command the window sent. */
function fakeFailedShell(reason: string): { commands: string[] } {
  const ledger = { commands: [] as string[] };
  let status: EngineStatus = { state: "failed", mode: "local", reason } as EngineStatus;
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command) => {
      ledger.commands.push(command);
      if (command === "engine_status") return status;
      if (command === "engine_unlock_retry") {
        // The shell removed the lock and re-entered start; the next status read says so.
        status = { state: "starting", mode: "local" } as EngineStatus;
        return status;
      }
      if (command === "mailto_claim") return null;
      return null;
    },
  };
  return ledger;
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

/* Typed loosely ON PURPOSE: the providers' overloads reject this mounting shape under the
   test-dirs ratchet, and this file must not raise that pin. The runtime tree is the same one the
   sibling gate tests mount. */
type Loose = (props: Record<string, unknown>, ...children: unknown[]) => React.ReactElement;
const Intl = IntlProvider as unknown as Loose;
const looseH = h as unknown as (c: Loose, p: Record<string, unknown> | null, ...k: unknown[]) => React.ReactElement;
const Theme = ThemeProvider as unknown as Loose;
const Toast = ToastHost as unknown as Loose;

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

describe("the locked-store card", () => {
  it("renders the clause and the reassurance, and the raw log line reaches nobody", async () => {
    fakeFailedShell(RAW_LOCKED_REASON);
    const el = await render();
    const said = el.textContent ?? "";
    expect(said).toContain(DOOR_COPY.gateCannotOpen);
    expect(said).toContain(DOOR_COPY.gateLockedStore);
    expect(said, "the footer's reassurance is the first thing this person needs").toContain(
      DOOR_COPY.gateFoot,
    );
    expect(said, "the raw log line reached the person").not.toContain('{"ts"');
    expect(said, "the developer field name reached the person").not.toContain("errorClass");
  });

  it("offers Unlock and retry, and the press asks the shell and re-reads the state", async () => {
    const ledger = fakeFailedShell(RAW_LOCKED_REASON);
    const el = await render();
    const button = [...el.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "") === DOOR_COPY.gateUnlockRetry,
    );
    expect(button, "no Unlock and retry control on the locked card").toBeDefined();
    const asked = ledger.commands.filter((c) => c === "engine_status").length;
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(ledger.commands, "the press never reached the shell").toContain("engine_unlock_retry");
    expect(
      ledger.commands.filter((c) => c === "engine_status").length,
      "the press never re-read the engine's state",
    ).toBeGreaterThan(asked);
  });

  it("any other structured failure names the class in a sentence, never the object", async () => {
    fakeFailedShell(RAW_OTHER_REASON);
    const el = await render();
    const said = el.textContent ?? "";
    expect(said).toContain(DOOR_COPY.gateEngineReported("SomethingElseError"));
    expect(said).not.toContain('{"ts"');
    // No unlock press for a failure the lock did not cause: removing a lock cannot fix it.
    const button = [...el.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "") === DOOR_COPY.gateUnlockRetry,
    );
    expect(button).toBeUndefined();
  });
});

describe("the two spellings of the lock file are one", () => {
  /**
   * The shell removes `<dataDir>/sidecar.lock` and the sidecar creates it; the literal lives in
   * two languages and nothing compiles them together. This reads both sources, so whichever side
   * renames the file meets this sentence before a person meets a press that removes nothing.
   */
  it("the Rust remover and the sidecar's LOCK_FILE name the same file", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rust = fs.readFileSync(path.resolve(here, "../src-tauri/src/engine.rs"), "utf8");
    const sidecar = fs.readFileSync(path.resolve(here, "../../sidecar/src/db.ts"), "utf8");
    expect(rust).toContain('dir.join("sidecar.lock")');
    expect(sidecar).toContain('export const LOCK_FILE = "sidecar.lock";');
  });
});
