/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import messages from "../messages/en.json";

/**
 * THE AI OFF SWITCH — the control behind a published promise.
 *
 * `faq.a3` says "you can switch the AI off entirely without losing a single feature that files
 * your mail", and `packages/api/src/routes/ai-settings.ts` names that sentence as the reason its
 * two endpoints exist. A promise with no control on any surface is a false claim, so this file
 * asserts BOTH halves: the sentence is still on the site, and there is a switch that writes the
 * flag it is about.
 *
 * The switch lived inside the subscription pane until that pane left. It is its own pane now
 * because the promise is about the ACCOUNT — a self-hosted server mounts these routes and has no
 * subscription at all, so a switch beside a plan would be missing exactly where the operator
 * pays the model bill themselves.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

/** `fileURLToPath(import.meta.url)` FIRST, then `path.join` — the idiom every jsdom test in
 *  this suite uses. `new URL("…", import.meta.url)` does not resolve to a file URL here. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

let host: HTMLDivElement;
let root: Root;

/** Every `/account/ai` request this mount made, in order, so a write can be read back. */
let calls: Array<{ method: string; body: unknown }> = [];
/** What the server answers. Reassigned per case, never captured by the stub. */
let serverFlag: boolean | null = true;
/** When set, every request fails with it. */
let transportFails = false;

beforeEach(() => {
  calls = [];
  serverFlag = true;
  transportFails = false;
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(url);
    if (!path.includes("/account/ai")) return new Response("{}", { status: 404 });
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
    calls.push({ method, body });
    if (transportFails) return new Response(JSON.stringify({ error: { code: "internal" } }), { status: 500 });
    if (method === "PATCH") serverFlag = (body as { aiEnabled: boolean }).aiEnabled;
    return new Response(JSON.stringify({ aiEnabled: serverFlag }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, children: h(ThemeProvider, { children: node }),
    }));
  });
}

const sw = (): HTMLButtonElement | null => host.querySelector('[role="switch"]');
const text = (): string => host.textContent ?? "";

async function press(): Promise<void> {
  await act(async () => { sw()!.click(); });
}

describe("the switch reads and writes the account's flag", () => {
  it("renders the server's position, not a guess", async () => {
    const { AiSection } = await import("../app/(product)/mailbox/AiSection");
    serverFlag = false;
    await mount(h(AiSection));
    expect(sw()!.getAttribute("aria-checked")).toBe("false");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("a press WRITES through the route, and the server's answer is what sticks", async () => {
    const { AiSection } = await import("../app/(product)/mailbox/AiSection");
    serverFlag = true;
    await mount(h(AiSection));
    expect(sw()!.getAttribute("aria-checked")).toBe("true");

    await press();
    // The write really went out, with the value the press meant.
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([{ method: "PATCH", body: { aiEnabled: false } }]);
    expect(sw()!.getAttribute("aria-checked")).toBe("false");
    // …and it is what the server now holds, so a re-read agrees.
    expect(serverFlag).toBe(false);

    await press();
    expect(sw()!.getAttribute("aria-checked")).toBe("true");
    expect(serverFlag).toBe(true);
  });

  it("AN UNREAD FLAG IS NOT A POSITION — the switch is drawn and not pressable", async () => {
    // A switch drawn OFF for an account that has it ON is a false statement about what that
    // account is doing, on the one screen that exists to state it.
    const { AiSection } = await import("../app/(product)/mailbox/AiSection");
    transportFails = true;
    await mount(h(AiSection));
    expect(sw(), "no switch at all").not.toBeNull();
    expect(sw()!.disabled, "an unread flag was rendered as a pressable position").toBe(true);
    expect(text(), "nothing said the read failed").toContain(messages.settings.aiUnreadable);
  });

  it("A REFUSED WRITE PUTS THE SWITCH BACK — it never keeps a position the server rejected", async () => {
    const { AiSection } = await import("../app/(product)/mailbox/AiSection");
    serverFlag = true;
    await mount(h(AiSection));
    transportFails = true;
    await press();
    expect(sw()!.getAttribute("aria-checked"), "the switch kept a value the write did not").toBe("true");
    expect(text()).not.toBe("");
  });

  it("says nothing about a plan, a price or a credit", async () => {
    // The pane it replaced said all three. This one is about the account's own setting, and a
    // self-hosted operator sees the same words.
    const { AiSection } = await import("../app/(product)/mailbox/AiSection");
    await mount(h(AiSection));
    expect(text()).not.toMatch(/credit|plan|price|subscription|trial|€|\$/i);
  });
});

describe("the promise the switch exists for", () => {
  /**
   * THE CLAIM, AND THE CONTROL BEHIND IT — asserted together, because either alone is what went
   * wrong. The sentence with no control is a false claim; a control with no sentence is a setting
   * nobody was promised. `ai-settings.ts` quotes this sentence as its own reason for existing.
   */
  it("faq.a3 still promises the off switch, and both catalogues carry the pane's copy", () => {
    const catalogue = (locale: string): Record<string, Record<string, string>> => JSON.parse(
      fs.readFileSync(path.join(HERE, "..", "messages", `${locale}.json`), "utf8"),
    ) as Record<string, Record<string, string>>;

    const en = catalogue("en");
    // The published promise, normalised on whitespace the way the claims guards next door do.
    const a3 = en.faq!.a3!.replace(/\s+/g, " ");
    expect(a3, "faq.a3 no longer promises the switch — then this pane owes nothing")
      .toContain("switch the AI off entirely");

    // …and the pane that keeps it true has every key it reads, in both languages.
    for (const locale of ["en", "de"]) {
      const settings = catalogue(locale).settings!;
      for (const key of ["ai", "aiLabel", "aiSub", "aiOffNote", "aiUnreadable"]) {
        expect(settings[key], `${locale}.settings.${key}`).toBeTruthy();
      }
      // The note is what keeps a rules-only result from reading as an outage, so it has to say
      // that rather than merely existing.
      expect(settings.aiOffNote!.length, `${locale} aiOffNote is too short to say anything`)
        .toBeGreaterThan(40);
    }
  });

});
