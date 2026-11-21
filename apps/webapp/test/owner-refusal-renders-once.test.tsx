/** @vitest-environment jsdom */
/**
 * AN OWNER REFUSAL IS SAID ONCE, IN THE READER'S LANGUAGE, WHEREVER A PANE CATCHES IT. The three
 * refusals are raised by this client and carry an English literal; the account panes rendered it
 * through `messageOf`, so a German reader got English. One renderer (`refusal-sentence.ts`) keys
 * on `ownerRefusalCodes()`; the Devices pane is driven into the mismatch for real, and a census
 * holds the other panes to the renderer.
 */
import { WithReport } from "../../../packages/app/test/support/with-report.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
/* @reads: apps/webapp/app/(product)/mailbox/DevicesSection.tsx
   apps/webapp/app/(product)/mailbox/SecuritySection.tsx
   apps/webapp/app/(product)/mailbox/InvitesSection.tsx
   apps/webapp/app/(product)/mailbox/AiSection.tsx
   apps/webapp/app/(product)/mailbox/account-door.ts
   apps/webapp/app/(product)/account/delete/use-delete-account-door.ts
   apps/webapp/app/(product)/mailbox/StepUpPrompt.tsx
   Read by a built path, so no landing pass would select this file when they move. */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const A = "0b7e3a52-5d2b-4c7e-9a41-2f1d6c8e9a01";
const B = "7c1d9e40-3b6a-4f2e-8d15-9e0a4b7c2d33";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  document.cookie = "tf_owner=; path=/; max-age=0";
  vi.unstubAllGlobals();
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
});

async function mountDevices(locale: "en" | "de"): Promise<HTMLElement> {
  const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : en, timeZone: "UTC",
      children: h(ThemeProvider, null, h(ToastHost, null, h(WithReport, { view: DevicesSection }))),
    }));
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

/** The inline step-up prompt alone, as a Settings pane hosts it — or, given one, with a page's settle step. */
async function mountPrompt(locale: "en" | "de", onOwnerAbsent?: () => void): Promise<HTMLElement> {
  const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const props = { onVerified: () => {}, onCancel: () => {}, onDiscarded: () => {}, ...(onOwnerAbsent ? { onOwnerAbsent } : {}) };
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : en, timeZone: "UTC", children: h(StepUpPrompt, props),
    }));
  });
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
  return host;
}

describe("the mirror-owner refusals render through one renderer", () => {
  it("the step-up prompt with no settle step says a lost marker in German, not the client's English literal", async () => {
    const { bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    // No marker at all: the prompt's own session read is refused before it is sent.
    const c = await mountPrompt("de");
    expect(c.textContent).toContain(de.session.refusedOwnerAbsent);
    expect(c.textContent).not.toContain("lost the name of the account");
  });

  it("given the page's settle step, the prompt hands a lost marker back once and says nothing", async () => {
    const { bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    let handed = 0;
    const c = await mountPrompt("en", () => { handed += 1; });
    expect(handed, "the prompt did not hand the refusal to the page").toBe(1);
    expect(c.querySelector('[role="alert"]'), "the prompt said the refusal itself").toBeNull();
  });

  it("every code ownerRefusalCodes() raises has a sentence, in English and in German", async () => {
    const { ownerRefusalCodes } = await import("../app/api-client.js");
    const { OWNER_REFUSAL_KEYS } = await import("../app/(product)/refusal-sentence.js");
    expect(ownerRefusalCodes().length, "the census read no codes").toBe(3);
    for (const code of ownerRefusalCodes()) {
      const key = OWNER_REFUSAL_KEYS[code];
      expect(key, `${code} has no sentence`).toBeDefined();
      expect((en.session as Record<string, string>)[key!], `en lacks session.${key}`).toBeTruthy();
      expect((de.session as Record<string, string>)[key!], `de lacks session.${key}`).toBeTruthy();
    }
  });

  it("the Devices pane, driven into a mismatch, says it in German — not the client's English literal", async () => {
    const { bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    document.cookie = `tf_owner=${B}; path=/`;
    const c = await mountDevices("de");
    expect(c.textContent).toContain(de.session.refusedOwnerMismatch);
    expect(c.textContent).not.toContain("This window is signed in to a different account");
  });

  it("control: the same pane in English says the English sentence, and a holding owner says nothing", async () => {
    const { bindApiOwner } = await import("../app/api-client.js");
    bindApiOwner(A);
    document.cookie = `tf_owner=${B}; path=/`;
    expect((await mountDevices("en")).textContent).toContain(en.session.refusedOwnerMismatch);
    await act(async () => root!.unmount());
    host?.remove();
    root = null;
    document.cookie = `tf_owner=${A}; path=/`;
    expect((await mountDevices("en")).textContent).not.toContain(en.session.refusedOwnerMismatch);
  });

  it("census: the account panes render a caught error through the renderer, never messageOf", () => {
    const panes = ["DevicesSection", "SecuritySection", "InvitesSection", "AiSection", "StepUpPrompt"]
      .map((name) => `mailbox/${name}.tsx`);
    panes.push("mailbox/account-door.ts", "account/delete/use-delete-account-door.ts");
    for (const pane of panes) {
      const src = fs.readFileSync(path.join(HERE, "../app/(product)", pane), "utf8");
      expect(src, `${pane} bypasses the renderer`).not.toMatch(/\bmessageOf\b/);
      expect(src, `${pane} does not use the renderer`).toMatch(/useRefusalSentence\(\)/);
    }
  });
});
