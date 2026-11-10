/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * THE EDITABLE OHBOX BAR PREFILLS THE DEFAULT — the "MYWORDS" change.
 *
 * The bar used to leave the box EMPTY when the account had never set one and show the product
 * default only as a placeholder: greyed, uneditable, and silent about what an empty box would do
 * on save. The fix prefills the default as real, editable text — you tweak words you can see —
 * while keeping "Save" inert until the text actually differs from the effective value, so an
 * untouched prefill writes nothing. This suite is the guard for both halves.
 *
 * `apps/webapp` typechecks its tests, so the wire shape below is checked as well as the values.
 */

// See `auto-suggest-toggle.test.tsx` for why React is published as a global and why API_BASE is
// set before the module under test (and its `api-client`) is imported.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

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

const DEFAULT_BAR = "Keep the mail from real people and the services you actually use.";

interface Wire {
  ohboxPolicy: "people_only" | "people_and_replied" | null;
  ohboxBar: string | null;
  defaultBar: string;
  screenerAutoApply: boolean;
  impersonationFiling?: boolean;
}

let stored: Wire;
let patchBodies: Array<{ ohboxPolicy?: unknown; ohboxBar?: unknown; screenerAutoApply?: unknown; impersonationFiling?: unknown }>;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const path = url.replace(/^\/api/, "");
    if (path === "/account/screening") {
      if ((init?.method ?? "GET") === "PATCH") {
        const body = JSON.parse(init!.body as string) as {
          ohboxPolicy?: unknown; ohboxBar?: unknown; screenerAutoApply?: unknown; impersonationFiling?: unknown;
        };
        patchBodies.push(body);
        if ("ohboxBar" in body) stored = { ...stored, ohboxBar: body.ohboxBar as string | null };
        if ("ohboxPolicy" in body) stored = { ...stored, ohboxPolicy: body.ohboxPolicy as Wire["ohboxPolicy"] };
        if ("screenerAutoApply" in body) stored = { ...stored, screenerAutoApply: body.screenerAutoApply as boolean };
        if ("impersonationFiling" in body) stored = { ...stored, impersonationFiling: body.impersonationFiling as boolean };
        return json(stored);
      }
      return json(stored);
    }
    return json({});
  }) as typeof fetch;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

async function mount(): Promise<void> {
  const { ScreeningSection } = await import("../app/shell/ScreeningSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ThemeProvider, { storageKey: null, children: h(ScreeningSection) }),
      }),
    );
  });
  await flush();
}

const textarea = (): HTMLTextAreaElement =>
  host!.querySelector(".set-screening-textarea") as HTMLTextAreaElement;
const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  Array.from(host!.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;

/** Type into the controlled textarea the way React reads it — set the value, then dispatch input. */
async function typeInto(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  patchBodies = [];
  stored = {
    ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: DEFAULT_BAR,
    screenerAutoApply: false,
  };
  installFetch();
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

describe("the editable Ohbox bar", () => {
  it("prefills the default as editable TEXT (not a placeholder) when none is stored, with Save inert", async () => {
    await mount();
    // The words are the box's VALUE, editable — not merely its placeholder.
    expect(textarea().value).toBe(DEFAULT_BAR);
    // And an untouched prefill is not a pending change: Save stays disabled.
    expect(buttonNamed(messages.settings.screening.save)!.disabled).toBe(true);
    // Nothing has been written just by opening the pane.
    expect(patchBodies).toHaveLength(0);
  });

  it("shows the account's OWN words when a bar has been set", async () => {
    stored.ohboxBar = "Only my clients and my kids' school.";
    await mount();
    expect(textarea().value).toBe("Only my clients and my kids' school.");
    expect(buttonNamed(messages.settings.screening.save)!.disabled).toBe(true);
  });

  it("arms Save once the text differs from the effective value, and writes the edited words", async () => {
    await mount();
    const save = buttonNamed(messages.settings.screening.save)!;
    expect(save.disabled).toBe(true);

    await typeInto(textarea(), "Keep the mail from real people, and every receipt.");
    expect(buttonNamed(messages.settings.screening.save)!.disabled).toBe(false);

    await act(async () => {
      buttonNamed(messages.settings.screening.save)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(patchBodies).toEqual([{ ohboxBar: "Keep the mail from real people, and every receipt." }]);
  });
});

/* NO SWITCH LETS A FIRST-TIME SENDER IN (owner report 2026-11-02): "File obvious bulk out of my
   Screener for me" let a stranger's letter into News on headers the sender writes. It is gone; a
   stored value from before draws nothing. The pane's switches are the posture and filing a held
   impersonation to Spam, which never lets anyone in. */
describe("no switch lets a first-time sender in", () => {
  it("draws no bulk-filing switch, whatever the stored value, and writes nothing on load", async () => {
    stored.screenerAutoApply = true;
    stored.impersonationFiling = true;
    await mount();
    const text = host!.textContent ?? "";
    expect(text).not.toContain("File obvious bulk out of my Screener");
    expect(text).not.toContain("Deterministic rules only");
    const switches = [...host!.querySelectorAll('button[role="switch"]')].map((b) => b.getAttribute("aria-label"));
    expect(switches).toEqual([messages.settings.screening.postureTitle, messages.settings.screening.impersonationTitle]);
    expect(patchBodies).toEqual([]);
  });
});

/* FILE IMPERSONATIONS TO SPAM (owner, 2026-11-09): on by default, turned off and on in place, and
   absent against a server that does not know it. */
describe("the impersonation filing switch", () => {
  const sw = (): HTMLButtonElement | undefined => [...host!.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
    .find((b) => b.getAttribute("aria-label") === messages.settings.screening.impersonationTitle);

  it("shows the stored value, writes only its own key, and says what off means", async () => {
    stored.impersonationFiling = true;
    await mount();
    expect(sw()!.getAttribute("aria-checked")).toBe("true");
    expect(host!.textContent).toContain(messages.settings.screening.impersonationOn);
    await act(async () => { sw()!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(patchBodies).toEqual([{ impersonationFiling: false }]);
    expect(sw()!.getAttribute("aria-checked")).toBe("false");
    expect(host!.textContent).toContain(messages.settings.screening.impersonationOff);
  });

  it("is absent against a server that does not send it", async () => {
    await mount();
    expect(sw()).toBeUndefined();
  });
});
