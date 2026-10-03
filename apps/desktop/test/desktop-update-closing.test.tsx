/** @vitest-environment jsdom */
/**
 * A QUIT WAITING FOR THE UPDATE'S INSTALL SAYS SO. The shell holds every exit while an install
 * writes the app and reports `closing` on the update report while a quit waits; the window says
 * one sentence until it closes. The shell's half (the fence, its doors and their stub install) is
 * `updater_tests.rs` and `engine_tests.rs`.
 */
/* @reads: apps/desktop/src-tauri/src/updater.rs */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { ToastHost } from "@ohmail/ui";

import { DOOR_COPY } from "../src/door-copy.js";
import { UpdateClosing } from "../src/update-closing.js";
import { reportOfPayload, resetUpdateFeedForTests, subscriberCountForTests } from "../src/update.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const globe = globalThis as unknown as {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback: (cb: (p: unknown) => void) => number };
};

/** The report `updater.rs` emits, spelled as it lands, with `closing` as given. */
const wire = (closing: unknown) => ({
  payload: {
    version: "0.25.12",
    state: "ready",
    offered: "0.25.13",
    installKind: "appimage",
    canCheck: false,
    canInstall: true,
    lastCheckedAt: null,
    lastResult: "offered",
    closing,
  },
});

let push: ((payload: unknown) => void) | null = null;

function fakeShell(): void {
  resetUpdateFeedForTests();
  push = null;
  globe.__TAURI_INTERNALS__ = {
    invoke: (command) => Promise.resolve(command === "plugin:event|listen" ? 1 : undefined),
    transformCallback: (cb) => {
      push = cb;
      return 1;
    },
  };
}

let host: HTMLDivElement;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host?.remove();
  delete globe.__TAURI_INTERNALS__;
  resetUpdateFeedForTests();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <React.StrictMode>
        <ToastHost>
          <UpdateClosing />
        </ToastHost>
      </React.StrictMode>,
    );
  });
  await settle();
}

async function tell(closing: unknown): Promise<void> {
  expect(push, "the window never listened for the update report").not.toBeNull();
  await act(async () => { push!(wire(closing)); });
  await settle();
}

describe("UpdateClosing", () => {
  it("says the one sentence when a quit waits on the install, in the polite live region", async () => {
    fakeShell();
    await mount();
    expect(host.textContent ?? "").not.toContain(DOOR_COPY.updateClosing);
    await tell(true);
    const text = host.textContent ?? "";
    expect(text.split(DOOR_COPY.updateClosing).length - 1).toBe(1);
    const live = [...host.querySelectorAll('[role="status"][aria-live="polite"]')].map((el) => el.textContent);
    expect(live).toContain(DOOR_COPY.updateClosing);
    // The report is re-sent while the quit waits; the sentence is not said twice.
    await tell(true);
    expect((host.textContent ?? "").split(DOOR_COPY.updateClosing).length - 1).toBe(1);
  });

  it("says nothing while no quit waits", async () => {
    fakeShell();
    await mount();
    await tell(false);
    await tell(undefined);
    expect(host.textContent ?? "").not.toContain(DOOR_COPY.updateClosing);
  });

  it("leaves the feed when the window's tree goes", async () => {
    fakeShell();
    await mount();
    expect(subscriberCountForTests()).toBe(1);
    await act(async () => { root!.unmount(); });
    root = null;
    expect(subscriberCountForTests()).toBe(0);
  });
});

describe("the report's closing field", () => {
  it("is true only when the shell says true", () => {
    expect(reportOfPayload(wire(true))?.closing).toBe(true);
    for (const said of [false, undefined, null, "true", 1]) {
      expect(reportOfPayload(wire(said))?.closing, String(said)).toBe(false);
    }
  });

  it("is the field the shell writes", () => {
    const rust = readFileSync(resolve(__dirname, "../src-tauri/src/updater.rs"), "utf8");
    expect(rust).toContain('told["closing"] = serde_json::Value::Bool(FENCE.quit_waits());');
  });

  it("the English sentence is pinned", () => {
    expect(DOOR_COPY.updateClosing).toBe("Installing the update. ohmail closes when it is done.");
  });
});
