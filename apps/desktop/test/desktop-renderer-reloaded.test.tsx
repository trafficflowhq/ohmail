/** @vitest-environment jsdom */
/**
 * A WINDOW THE SHELL RELOADED AFTER ITS WEB PROCESS DIED SAYS SO, ONCE. The shell marks the
 * address (`renderer_recovery.rs`'s `RELOADED_MARK`, `reload_uri`); the page takes the mark
 * before its first render, puts the address back with the view it showed, and says one sentence.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { ToastHost } from "@ohmail/ui";

import { RELOADED_PARAM, RELOADED_VALUE, RendererReloaded, takeReloadedMark } from "../src/renderer-reloaded.js";
import { DOOR_COPY } from "../src/door-copy.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

function place(search: string, hash = "", pathname = "/") {
  const calls: string[] = [];
  return {
    calls,
    loc: { search, hash, pathname },
    entries: { state: { kept: true }, replaceState: (_s: unknown, _u: string, url?: string) => { calls.push(url ?? ""); } },
  };
}

describe("takeReloadedMark", () => {
  it("takes the shell's mark once and keeps the view the window showed", () => {
    const p = place("?renderer=reloaded", "#history");
    expect(takeReloadedMark(p.loc, p.entries)).toBe(true);
    expect(p.calls).toEqual(["/#history"]);
  });

  it("an address without the mark is left alone and says nothing", () => {
    const p = place("", "#ohbox");
    expect(takeReloadedMark(p.loc, p.entries)).toBe(false);
    expect(p.calls).toEqual([]);
    const q = place("?renderer=something-else");
    expect(takeReloadedMark(q.loc, q.entries)).toBe(false);
    expect(q.calls).toEqual([]);
  });

  it("another parameter on the address survives the take", () => {
    const p = place("?renderer=reloaded&from=menu", "#screener");
    expect(takeReloadedMark(p.loc, p.entries)).toBe(true);
    expect(p.calls).toEqual(["/?from=menu#screener"]);
  });

  it("reads the mark the shell writes, spelled once on each side", () => {
    const rust = readFileSync(resolve(__dirname, "../src-tauri/src/renderer_recovery.rs"), "utf8");
    expect(rust).toContain(`pub const RELOADED_MARK: &str = "${RELOADED_PARAM}=${RELOADED_VALUE}";`);
  });
});

describe("RendererReloaded", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host.remove();
  });
  const mount = async (reloaded: boolean): Promise<void> => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <React.StrictMode>
          <ToastHost>
            <RendererReloaded reloaded={reloaded} />
          </ToastHost>
        </React.StrictMode>,
      );
    });
  };

  it("says the one sentence after a reload, in the polite live region", async () => {
    await mount(true);
    const text = host.textContent ?? "";
    expect(text).toContain(DOOR_COPY.rendererReloaded);
    expect(text.split(DOOR_COPY.rendererReloaded).length - 1).toBe(1);
    const live = [...host.querySelectorAll('[role="status"][aria-live="polite"]')].map((el) => el.textContent);
    expect(live).toContain(DOOR_COPY.rendererReloaded);
  });

  it("says nothing on an ordinary launch", async () => {
    await mount(false);
    expect(host.textContent ?? "").not.toContain(DOOR_COPY.rendererReloaded);
  });

  it("the sentence is the brief's, in English", () => {
    expect(DOOR_COPY.rendererReloaded).toBe("ohmail's window stopped and was reloaded.");
  });
});
