/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider } from "@ohmail/ui";
import {
  DURABILITY_LOST_EVENT,
  type DurabilityLostDetail,
  localStorageDoor,
  resetDurabilityForTest,
  storageDoor,
} from "@ohmail/client-engine/durable";

import messages from "../../webapp/messages/en.json";
import { DurabilityNotice } from "../../webapp/app/shell/DurabilityNotice";
import { BearerManager, REFRESH_STORAGE_KEY } from "../src/host-client/bearer.js";

/**
 * ═══ A WRITE THIS WINDOW LOST IS SAID IN THIS WINDOW — the desktop's arm of the same door ═════
 *
 * What was true before: `apps/desktop/src` wrote `localStorage` in six places inside swallowing
 * `try` blocks, and it could not do otherwise — the door that answers lived in `apps/webapp` and
 * the desktop compiles that app's shell but is not it. So a window with storage denied lost the
 * pairing's refresh token and the first-run answer silently, and the shared shell's notice strip
 * — which this window already mounts — had nothing to render.
 *
 * The mechanism is NOT a new one: the desktop imports the same door from
 * `@ohmail/client-engine/durable` (resolved by this project's `vite.config.ts` alias and
 * `tsconfig.json` paths, both asserted by `test/durable-write-census.test.ts`), and the door
 * raises the SAME `window` event the shell's `DurabilityNotice` already listens for. These cases
 * drive the desktop's own code and read the shell's own strip, so nothing here is a claim about a
 * wiring that only exists in a test.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · `this.door.set(REFRESH_STORAGE_KEY, …)` in `bearer.ts#adopt` → a bare
 *    `this.storage?.setItem(…)` in a `try` → "a refused pairing write draws the strip" goes red:
 *    no event, no strip;
 *  · `storageDoor(opts.storage ?? defaultStorage(), "host-pair")` → `storageDoor(null, …)` →
 *    "the ordinary pairing write draws nothing" goes red, because every write then answers lost;
 *  · `ThemeProvider … storage={THEME_DOOR}` dropped from `main.tsx` → "the theme's refused write
 *    draws the strip" goes red (the provider is unpersisted and writes nothing at all).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** A jar that refuses every write the way a window with storage denied does. */
function refusingJar(): Storage {
  const kept = new Map<string, string>();
  return {
    get length() { return kept.size; },
    clear: () => kept.clear(),
    getItem: (k: string) => kept.get(k) ?? null,
    key: (i: number) => [...kept.keys()][i] ?? null,
    removeItem: () => { throw new DOMException("removal refused", "QuotaExceededError"); },
    setItem: () => { throw new DOMException("quota exceeded", "QuotaExceededError"); },
  } as Storage;
}

function memoryJar(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

let heard: DurabilityLostDetail[] = [];
const listen = (e: Event): void => { heard.push((e as CustomEvent<DurabilityLostDetail>).detail); };

const realJar = Object.getOwnPropertyDescriptor(window, "localStorage");

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

/** The shell's strip, mounted the way this window mounts it: intl over the webapp's catalogue. */
async function mountShellNotice(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      <IntlProvider locale="en" messages={messages as never} timeZone="UTC">
        <DurabilityNotice />
      </IntlProvider>,
    );
  });
  return mountPoint;
}

const strip = (): HTMLElement | null => mountPoint!.querySelector(".ohx-durability");

beforeEach(() => {
  resetDurabilityForTest();
  heard = [];
  window.addEventListener(DURABILITY_LOST_EVENT, listen);
});
afterEach(async () => {
  window.removeEventListener(DURABILITY_LOST_EVENT, listen);
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  if (realJar) Object.defineProperty(window, "localStorage", realJar);
  delete document.documentElement.dataset.theme;
});

const TOKENS = { accessToken: "access-1", refreshToken: "refresh-1" };
const noFetch = async (): Promise<Response> => new Response(null, { status: 204 });

describe("the desktop's lost writes reach the shell's own notice", () => {
  it("the ordinary pairing write lands, and draws nothing", async () => {
    const jar = memoryJar();
    await mountShellNotice();
    await act(async () => {
      new BearerManager({ storage: jar, fetchImpl: noFetch }).adopt(TOKENS, { fresh: true });
    });
    expect(jar.getItem(REFRESH_STORAGE_KEY)).toBe("refresh-1");
    expect(heard).toEqual([]);
    expect(strip(), "nothing was lost, so there is no strip").toBeNull();
  });

  it("a refused pairing write draws the strip, with the shell's own sentence", async () => {
    await mountShellNotice();
    expect(strip()).toBeNull();
    await act(async () => {
      new BearerManager({ storage: refusingJar(), fetchImpl: noFetch }).adopt(TOKENS, { fresh: true });
    });
    expect(heard.map((d) => d.store)).toContain("host-pair");
    const bar = strip();
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("role")).toBe("status");
    expect(bar!.textContent).toContain(messages.session.storageRefused);
  });

  it("the window's THEME is on the same door, and its refusal draws the same strip", async () => {
    Object.defineProperty(window, "localStorage", { value: refusingJar(), configurable: true });
    await mountShellNotice();
    // Exactly `main.tsx`'s wiring: the provider takes the client-engine door, not a jar.
    const themePoint = document.createElement("div");
    document.body.appendChild(themePoint);
    const themeRoot = createRoot(themePoint);
    await act(async () => {
      themeRoot.render(
        <ThemeProvider storageKey="ohmail.theme" faces storage={localStorageDoor("theme")}>
          <span />
        </ThemeProvider>,
      );
    });
    // The provider adopts post-mount and then STAMPS, which is the write that answers.
    expect(heard.map((d) => d.store), "the theme write must answer through the door")
      .toContain("theme");
    expect(strip()).not.toBeNull();
    await act(async () => { themeRoot.unmount(); });
    themePoint.remove();
  });

  it("the strip is once per session and can be put away — two lost writes, one sentence", async () => {
    await mountShellNotice();
    await act(async () => {
      const door = storageDoor(refusingJar(), "first-run.ai");
      door.set("ohmail.first-run.ai", "yes");
      door.set("ohmail.first-run.ai", "no");
    });
    expect(heard.length, "each lost write still fires — every caller has its own degradation")
      .toBe(2);
    expect(mountPoint!.querySelectorAll(".ohx-durability").length, "one strip, not two").toBe(1);
    const dismiss = mountPoint!.querySelector<HTMLButtonElement>(".upd-later");
    expect(dismiss).not.toBeNull();
    await act(async () => { dismiss!.click(); });
    expect(strip(), "a dismissal is not undone by the next loss").toBeNull();
    await act(async () => { storageDoor(refusingJar(), "first-run.ai").set("k", "v"); });
    expect(strip()).toBeNull();
  });
});
