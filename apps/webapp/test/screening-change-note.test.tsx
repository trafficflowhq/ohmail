/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * A SCREENING CHANGE MADE ON A READER SAYS WHERE IT WENT — the web pane, over the real
 * `ScreeningSection` and its `api-client` calls, against a fetch that answers as a reader's
 * server does (`GET/PATCH /account/screening` with `pending` and `change`). "Saved." at the press
 * was the defect: the change had been sent, not saved, and the holder's answer never reached it.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

type Change = { state: "asked" | "applied" | "refused"; holder: string | null; refusal: "unreadable" | "other" | null };
interface Wire {
  ohboxPolicy: "people_only" | "people_and_replied" | null;
  ohboxBar: string | null;
  defaultBar: string;
  pending?: true;
  change?: Change;
}

const S = messages.settings.screening;
/** The away row's sentence for the same state — the one the pane reuses. */
const ASKED = messages.away.asked;
const DEFAULT_BAR = "Keep the mail from real people and the services you actually use.";
let reader: boolean;
let stored: Wire;
/** What the holder has done with the last change, as the reader's next read reports it. */
let answer: { change?: Change; applied?: Partial<Wire> };
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, "");
    if (path !== "/account/screening") return json({});
    const read = (): Wire => ({ ...stored, ...(answer.applied ?? {}), ...(answer.change ? { change: answer.change } : {}) });
    if ((init?.method ?? "GET") !== "PATCH") return json(read());
    const body = JSON.parse(init!.body as string) as Partial<Wire>;
    if (!reader) { stored = { ...stored, ...body }; return json(stored); }
    answer = { ...answer, change: { state: "asked", holder: null, refusal: null } };
    return json({ ...read(), pending: true });
  }) as typeof fetch;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};
const poll = async (): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  await flush();
};

async function mount(): Promise<void> {
  const { ScreeningSection } = await import("../app/shell/ScreeningSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(ScreeningSection) }),
    }));
  });
  await flush();
}

const text = (): string => host!.textContent ?? "";
const posture = (): HTMLButtonElement =>
  host!.querySelector(`button[role="switch"][aria-label="${S.postureTitle}"]`) as HTMLButtonElement;
const textarea = (): HTMLTextAreaElement => host!.querySelector(".set-screening-textarea") as HTMLTextAreaElement;
const buttonNamed = (label: string): HTMLButtonElement =>
  Array.from(host!.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement;
async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  reader = true;
  stored = { ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: DEFAULT_BAR };
  answer = {};
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
  vi.useRealTimers();
});

describe("a Screening change on a reader", () => {
  it("says it was sent at the press, never Saved.", async () => {
    await mount();
    await act(async () => { posture().click(); });
    await flush();
    expect(text(), "the pane said Saved. over a change it only sent").not.toContain(S.saved);
    expect(text()).toContain(ASKED);
    expect(S.asked, "the pane's sentence is not the away row's").toBe(ASKED);
    expect(posture().getAttribute("aria-checked"), "the switch shows a value nothing stored").toBe("false");
  });

  it("says Applied. when the holder acks it, over the value it applied", async () => {
    await mount();
    await act(async () => { posture().click(); });
    await flush();
    answer = { change: { state: "applied", holder: null, refusal: null }, applied: { ohboxPolicy: "people_only" } };
    await poll();
    expect(text()).toContain(S.applied);
    expect(text()).not.toContain(S.asked);
    expect(posture().getAttribute("aria-checked")).toBe("true");
  });

  it("names the install that could not read it, and the switch stays where it is", async () => {
    await mount();
    await act(async () => { posture().click(); });
    await flush();
    answer = { change: { state: "refused", holder: "work-laptop", refusal: "unreadable" } };
    await poll();
    expect(text()).toContain(S.refusedUnreadable.replace("{name}", "work-laptop"));
    expect(posture().getAttribute("aria-checked")).toBe("false");
  });

  it("shows a refusal it finds on opening the pane, and an old Applied. is not news", async () => {
    answer = { change: { state: "refused", holder: null, refusal: "other" } };
    await mount();
    expect(text()).toContain(S.refusedOtherUnknown);
    if (root) await act(async () => { root!.unmount(); });
    host?.remove();
    answer = { change: { state: "applied", holder: null, refusal: null } };
    await mount();
    expect(text()).not.toContain(S.applied);
  });

  it("the words: sent, not saved, and the applied words reach the box", async () => {
    await mount();
    await typeInto(textarea(), "People I know, and my bank.");
    await act(async () => { buttonNamed(S.save).click(); });
    await flush();
    expect(text(), "the words said Saved. over a save that only travelled").not.toContain(S.saved);
    expect(text()).toContain(ASKED);
    expect(textarea().value, "the box shows words nothing stored").toBe(DEFAULT_BAR);
    answer = { change: { state: "applied", holder: null, refusal: null }, applied: { ohboxBar: "People I know, and my bank." } };
    await poll();
    expect(text()).toContain(S.applied);
    expect(textarea().value).toBe("People I know, and my bank.");
  });

  it("CONTROL: an install that organizes still says Saved.", async () => {
    reader = false;
    await mount();
    await act(async () => { posture().click(); });
    await flush();
    expect(text()).toContain(S.saved);
    expect(text()).not.toContain(S.asked);
    expect(posture().getAttribute("aria-checked")).toBe("true");
  });
});
