/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { Fixtures, MessageFixture } from "@ohmail/testing";
import messages from "../messages/en.json";

/**
 * THE PILES IN ONE ORDER, AS THE SHELL RENDERS THEM. The web and both desktops mount
 * this one `AppShell`; what differed was the order the claims reached each mirror. The demo world
 * emits its claims in the fixture's pile order, so listing six messages set aside in an order that
 * is not their arrival order is the web's arrival exactly. Answer Later, its Reply Run and Parked
 * must read newest arrival first; the same six set aside newest first (the desktop's arrival)
 * must read the same.
 */

const SIX: Array<{ id: string; time: string; who: string }> = [
  { id: "p-a", time: "10:15", who: "Sender A" },
  { id: "p-b", time: "10:43", who: "Sender B" },
  { id: "p-c", time: "11:21", who: "Sender C" },
  { id: "p-d", time: "09:41", who: "Sender D" },
  { id: "p-e", time: "09:18", who: "Sender E" },
  { id: "p-f", time: "09:16", who: "Sender F" },
];
const NEWEST_FIRST = ["Sender C", "Sender B", "Sender A", "Sender D", "Sender E", "Sender F"];

const world = vi.hoisted(() => ({ pile: "replyLater" as "replyLater" | "setAside", ids: [] as string[] }));

vi.mock("@ohmail/testing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ohmail/testing")>();
  return {
    ...real,
    getFixtures: (): Fixtures => {
      const fx = real.getFixtures();
      const base = fx.ohbox[0]!;
      const six: MessageFixture[] = SIX.map((s) => ({
        ...base, id: s.id, time: s.time, unread: false, attachment: undefined,
        from: { name: s.who, address: `${s.id}@example.invalid` },
        subject: `About ${s.id}`, snippet: `snippet ${s.id}`, body: `body ${s.id}`,
      }));
      const byId = new Map(six.map((m) => [m.id, m]));
      const parked = world.ids.map((id) => ({ messageId: id, title: byId.get(id)!.from.name }));
      return {
        ...fx,
        ohbox: [...fx.ohbox, ...six],
        triage: { ...fx.triage, replyLater: world.pile === "replyLater" ? parked : [], setAside: world.pile === "setAside" ? parked : [] },
      };
    },
  };
});

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function shell(hash: string): Promise<HTMLElement> {
  window.location.hash = hash;
  const { AppShell } = await import("../app/shell/AppShell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-07-29T12:00:00.000Z"),
      children: h(ThemeProvider, { children: h(ToastHost, { children: h(AppShell, { demo: true }) }) }),
    }));
  });
  return container;
}

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

const pileRows = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(".view-triage .list-col .rows .row .who")].map((b) => b.textContent ?? "");
const runSubject = (el: HTMLElement): string => el.querySelector(".fr-card h3")?.textContent ?? "";

async function key(k: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

describe("the triage piles render one order, whatever order the claims arrived in", () => {
  it.each([
    ["set aside out of date order (the web's arrival)", ["p-a", "p-b", "p-c", "p-d", "p-e", "p-f"]],
    ["set aside newest first (the desktop's arrival)", ["p-c", "p-b", "p-a", "p-d", "p-e", "p-f"]],
  ])("Answer Later and its Reply Run, %s", async (_label, ids) => {
    world.pile = "replyLater";
    world.ids = ids;
    const el = await shell("#/triage");
    await waitFor(() => pileRows(el).length === 6, "the six Answer Later rows");
    expect(pileRows(el)).toEqual(NEWEST_FIRST);

    await key("f");
    await waitFor(() => runSubject(el) !== "", "the Reply Run to open");
    const walked: string[] = [runSubject(el)];
    for (let i = 0; i < 5; i++) {
      const before = runSubject(el);
      const skip = [...el.querySelectorAll<HTMLButtonElement>(".fr-foot button")][1]!;
      await act(async () => { skip.click(); });
      await waitFor(() => runSubject(el) !== before, `Reply Run step ${i + 2}`);
      walked.push(runSubject(el));
    }
    expect(walked).toEqual(["p-c", "p-b", "p-a", "p-d", "p-e", "p-f"].map((id) => `About ${id}`));
  });

  it("Parked, set aside out of date order", async () => {
    world.pile = "setAside";
    world.ids = ["p-a", "p-b", "p-c", "p-d", "p-e", "p-f"];
    const el = await shell("#/triage/aside");
    await waitFor(() => pileRows(el).length === 6, "the six Parked rows");
    expect(pileRows(el)).toEqual(NEWEST_FIRST);
  });
});
