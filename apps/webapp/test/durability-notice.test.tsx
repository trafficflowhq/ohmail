/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";

import en from "../messages/en.json";
import de from "../messages/de.json";
import { DurabilityNotice } from "../app/shell/DurabilityNotice";
import {
  DURABILITY_LOST_EVENT,
  DurabilityLostEvent,
  durabilityLost,
  durableRemove,
  durableSet,
  resetDurabilityForTest,
} from "@ohmail/app-logic/storage/durable";

/**
 * THE BROWSER IS NOT KEEPING DECISIONS, AND THE PRODUCT SAYS SO ONCE.
 *
 * The class this closes: every store the durability slice added swallowed its own write failure,
 * so a private window turned a "durable" decision back into the in-memory one it replaced with
 * nothing anywhere saying so. The write answers now, and the shell's strip is the once-per-session
 * sentence. Both directions are asserted — a refused jar draws it, a healthy jar never does.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(messages: unknown = en): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: messages as never, timeZone: "UTC", children: h(DurabilityNotice),
    }));
  });
}

const strip = (): HTMLElement | null => host?.querySelector(".ohx-durability") ?? null;

beforeEach(() => {
  resetDurabilityForTest();
  window.localStorage.clear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("a lost durable write", () => {
  it("answers `lost`, and a healthy jar answers `stored`", () => {
    expect(durableSet("k", "v", "probe")).toBe("stored");
    expect(durableRemove("k", "probe")).toBe("stored");
    expect(durabilityLost(), "a healthy jar must raise nothing").toBe(false);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(durableSet("k", "v", "probe")).toBe("lost");
    expect(durabilityLost()).toBe(true);
  });

  it("raises the event on EVERY refused write — each caller has its own degradation to run", () => {
    const seen: string[] = [];
    const onLost = (e: Event) => { seen.push((e as DurabilityLostEvent).detail.store); };
    window.addEventListener(DURABILITY_LOST_EVENT, onLost);
    try {
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("q"); });
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("q"); });
      durableSet("a", "1", "first");
      durableRemove("a", "second");
      expect(seen).toEqual(["first", "second"]);
    } finally {
      window.removeEventListener(DURABILITY_LOST_EVENT, onLost);
    }
  });
});

describe("the notice", () => {
  it("is absent while every write lands", async () => {
    await mount();
    expect(strip(), "a strip nobody needs was drawn").toBeNull();
  });

  it("appears on the first refused write, and says what is true of the browser", async () => {
    await mount();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("q"); });
    await act(async () => { durableSet("k", "v", "probe"); });
    expect(strip()?.textContent).toContain(en.session.storageRefused);
  });

  it("is on screen for a write refused BEFORE the shell mounted", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("q"); });
    durableSet("k", "v", "probe");
    await mount();
    expect(strip(), "the strip only adopted state it saw arrive").not.toBeNull();
  });

  it("is said ONCE per session: dismissed, and the next refused write does not bring it back", async () => {
    await mount();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("q"); });
    await act(async () => { durableSet("k", "v", "probe"); });
    const dismiss = strip()!.querySelector("button")!;
    await act(async () => { dismiss.click(); });
    expect(strip()).toBeNull();
    await act(async () => { durableSet("k2", "v", "probe"); });
    expect(strip(), "a dismissed notice came back on the next refused write").toBeNull();
  });

  /**
   * THE SHELL MOUNTS IT, asserted over the source rather than by mounting the shell.
   *
   * A one-line JSX mount whose absence is silent: every case above would stay green with the strip
   * rendered by nobody. Mounting the whole shell costs half a minute and would measure the mount's
   * gates rather than its presence, so this reads the file — the same way the sign-out census reads
   * the sources it disposes of.
   */
  it("is rendered by the shell, beside the update strip", () => {
    /* Resolved the way the sign-out census resolves its own reads — the suite runs from the repo
       root, and a run from the app directory is the second spelling. Asserted non-empty first, so
       a path that resolved to nothing cannot pass this case by finding nothing to object to. */
    const file = existsSync(resolve("apps/webapp/app/shell/AppShell.tsx"))
      ? resolve("apps/webapp/app/shell/AppShell.tsx")
      : resolve("app/shell/AppShell.tsx");
    const src = readFileSync(file, "utf8");
    expect(src.length, `read nothing from ${file}`).toBeGreaterThan(1000);
    expect(src, "the shell does not import the notice")
      .toContain('import { DurabilityNotice } from "./DurabilityNotice";');
    expect(src, "the shell imports the notice and never renders it")
      .toContain("<DurabilityNotice />");
  });

  it("says it in German too", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("q"); });
    durableSet("k", "v", "probe");
    await mount(de);
    expect(strip()?.textContent).toContain(de.session.storageRefused);
  });
});
