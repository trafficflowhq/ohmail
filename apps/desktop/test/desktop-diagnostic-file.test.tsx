/** @vitest-environment jsdom */
/**
 * SETTINGS → ABOUT → DIAGNOSTIC FILE, rendered. One press asks the shell for the log's tail,
 * builds the file with the builder the phone shares and hands the text to the shell's save; the
 * row then names where the file is and says nothing was sent. The shell half is read from its
 * source: the file name and kind the save accepts are the builder's own. A window with no shell
 * draws no row, and the hosted web app has no such row at all.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { DIAGNOSTIC_BUNDLE_KIND, DIAGNOSTIC_FILE_NAME } from "@trafficflow/core/diagnostics";

import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import { DiagnosticFileRow } from "../src/DesktopAbout.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host { __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } }
const host = globalThis as unknown as Host;

const HOST_NAME = "imap.kestrel-mail.example";
const WRITTEN = "/home/ann/.local/share/app.ohmail/logs/ohmail-diagnostics.json";
let saved: string[] = [];
let root: Root | null = null;
let el: HTMLDivElement | null = null;

function shell(opts: { refuseSave?: boolean } = {}): void {
  host.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      if (command === "diagnostic_facts") {
        return Promise.resolve({
          os: "linux",
          arch: "x86_64",
          lines: [JSON.stringify({ ts: "2026-09-27T04:00:00.000Z", level: "warn", service: "engine", event: "imap_connect_failed", host: HOST_NAME, attempt: 2 })],
        });
      }
      if (command === "diagnostic_save") {
        if (opts.refuseSave) return Promise.reject(new Error("ohmail: that is not a diagnostic file"));
        saved.push(String(payload?.text));
        return Promise.resolve(WRITTEN);
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    },
  };
}

async function render(messages: typeof en | typeof de, locale: string): Promise<HTMLDivElement> {
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(() => {
    root?.render(h(NextIntlClientProvider, { locale, messages: messages as never, timeZone: "UTC", children: h(DiagnosticFileRow) }));
  });
  return el;
}

async function press(node: HTMLDivElement): Promise<void> {
  const button = node.querySelector("button");
  if (!button) throw new Error("the row drew no button");
  await act(async () => { button.click(); });
  for (let i = 0; i < 20 && node.querySelector("button")?.hasAttribute("disabled"); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

beforeEach(() => { saved = []; });
afterEach(async () => {
  if (root) await act(() => { root?.unmount(); });
  el?.remove();
  root = null;
  delete host.__TAURI_INTERNALS__;
  setActiveCatalog(DEFAULT_LOCALE, null);
});

describe("the desktop's diagnostic file row", () => {
  it("one press writes the builder's file through the shell and names where it is", async () => {
    shell();
    const node = await render(en, "en");
    expect(node.textContent).toContain(en.desktopDoor.diagnosticWhy);
    await press(node);
    expect(saved).toHaveLength(1);
    const file = JSON.parse(saved[0]!) as { kind: string; sections: { k: string }[] };
    expect(file.kind).toBe(DIAGNOSTIC_BUNDLE_KIND);
    expect(file.sections.map((s) => s.k)).toContain("log");
    expect(saved[0]).toContain('"imap_connect_failed"');
    expect(saved[0]).not.toContain(HOST_NAME);
    expect(node.textContent).toContain(en.desktopDoor.diagnosticWritten.replace("{path}", WRITTEN));
    expect(node.textContent).toContain("Nothing was sent.");
  });

  it("the same row speaks German under a German catalogue", async () => {
    shell();
    // What `DesktopLocale` sets for German: English filled underneath.
    setActiveCatalog("de", fillFrom(en as never, de as never) as never);
    const node = await render(de, "de");
    await press(node);
    expect(node.textContent).toContain(de.desktopDoor.diagnosticWritten.replace("{path}", WRITTEN));
  });

  it("a refused save says so and keeps the button", async () => {
    shell({ refuseSave: true });
    const node = await render(en, "en");
    await press(node);
    expect(node.textContent).toContain(en.desktopDoor.diagnosticFailed);
    expect(node.querySelector("button")?.textContent).toBe(en.desktopDoor.diagnosticAction);
  });

  it("a window with no shell draws no row — there is no log to write beside", async () => {
    const node = await render(en, "en");
    expect(node.textContent).toBe("");
  });

  it("the shell writes the builder's file name and accepts only the builder's kind", () => {
    const engine = readFileSync("apps/desktop/src-tauri/src/engine.rs", "utf8");
    expect(engine).toContain(`pub const DIAGNOSTIC_FILE_NAME: &str = "${DIAGNOSTIC_FILE_NAME}";`);
    expect(engine).toContain(`const DIAGNOSTIC_KIND: &str = "${DIAGNOSTIC_BUNDLE_KIND}";`);
  });

  it("About mounts the row, and the hosted web app carries no diagnostic action", () => {
    expect(readFileSync("apps/desktop/src/DesktopAbout.tsx", "utf8")).toContain("<DiagnosticFileRow />");
    const webKeys = Object.entries(en as Record<string, Record<string, unknown>>)
      .filter(([ns]) => ns !== "desktopDoor")
      .flatMap(([ns, table]) => Object.keys(table ?? {}).filter((k) => /diagnostic/i.test(k)).map((k) => `${ns}.${k}`));
    expect(webKeys).toEqual([]);
    // Control: the reader does find the desktop's own keys.
    expect(Object.keys(en.desktopDoor).filter((k) => /diagnostic/i.test(k)).length).toBe(6);
  });
});
