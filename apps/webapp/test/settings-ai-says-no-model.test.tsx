/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

/**
 * SETTINGS → AI ON A SELF-HOSTED SERVER WITH NO MODEL says the server has none, beside the switch,
 * in the sentence Suggest uses. The switch alone read as "AI is on" on a server where no model
 * can answer; setup already says so, and this pane now does too.
 */

let unmount: (() => Promise<void>) | null = null;
let originalFetch: typeof globalThis.fetch;
let helloAsked = 0;

afterEach(async () => {
  if (unmount) await unmount();
  unmount = null;
  if (originalFetch) globalThis.fetch = originalFetch;
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
  vi.restoreAllMocks();
});

async function pane(flavor: "selfhost" | "managed", ai: boolean, hosted = false): Promise<HTMLElement> {
  helloAsked = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/hello")) {
      helloAsked += 1;
      return json({ product: "ohmail", flavor: "selfhost", needsSetup: false, features: { staging: false, ai, pairing: false } });
    }
    if (url.includes("/account/ai")) return json({ aiEnabled: true });
    return json({});
  }) as unknown as typeof globalThis.fetch;
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  if (flavor === "selfhost") process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { NextIntlClientProvider } = await import("next-intl");
  const { AiSection } = await import("../app/(product)/mailbox/AiSection.js");
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", children: React.createElement(AiSection, hosted ? {
        credits: { remaining: 120, total: 150, draftCost: 17 },
        draftReplies: { enabled: true, set: vi.fn() },
      } : {}),
    }));
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  return host;
}

describe("Settings → AI and the server's model", () => {
  it("a self-hosted server with no model says so beside the switch", async () => {
    const el = await pane("selfhost", false);
    expect(el.querySelector('[role="switch"]'), "the switch is still there").toBeTruthy();
    expect(el.textContent).toContain(en.aiRefusal.noModel);
  });

  it("a self-hosted server with a model says nothing of the kind", async () => {
    const el = await pane("selfhost", true);
    expect(el.textContent).not.toContain(en.aiRefusal.noModel);
  });

  it("shows the quoted Draft reply price beside the switch and the budget meter below it", async () => {
    const el = await pane("managed", true, true);
    const draft = el.querySelector('[role="switch"][aria-label="Draft reply"]')?.closest(".oh-settingline");
    expect(draft?.textContent).toContain("Draft reply");
    expect(draft?.textContent).toContain("17 credits a draft");
    expect(el.querySelector("progress")?.max).toBe(150);
    expect(el.querySelector("progress")?.value).toBe(120);
  });

  it("aligns the Draft reply label with the main AI switch", async () => {
    const el = await pane("managed", true, true);
    const ai = el.querySelector(`[role="switch"][aria-label="${en.settings.aiLabel}"]`)?.closest(".oh-settingline");
    const draft = el.querySelector('[role="switch"][aria-label="Draft reply"]')?.closest(".oh-settingline");
    expect(ai).toBeTruthy();
    expect(draft?.hasAttribute("data-sub")).toBe(ai?.hasAttribute("data-sub"));
  });

  it("the managed service asks no /hello and says nothing of the kind", async () => {
    const el = await pane("managed", false);
    expect(helloAsked).toBe(0);
    expect(el.textContent).not.toContain(en.aiRefusal.noModel);
  });
});
