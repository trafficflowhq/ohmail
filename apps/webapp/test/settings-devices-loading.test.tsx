/** @vitest-environment jsdom */
import { WithReport } from "../../../packages/app/test/support/with-report.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

/**
 * THE DEVICES PANE SAYS WHAT IT IS DOING — loading, failed, or the list.
 *
 * `GET /devices` can be slow, and the pane rendered NOTHING where the list belongs until it
 * answered: a long blank that reads as a pane with no devices, reported from real use. Three
 * claims, each of which the old render had no arm for:
 *
 *   · while the first read is in flight, a loading sentence stands where the list will —
 *     under the same subhead the list keeps, so nothing around it jumps when rows arrive;
 *   · a first read that FAILS gets a plain sentence and a retry that refetches, not a warning
 *     line over a permanent blank;
 *   · the states are exclusive: rows end the sentence, the sentence never renders over rows.
 *
 * The copy goes through the same `t.has` shim the shared Reader's `copy` uses, so the locale files own
 * every line the moment the keys land there.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WEB_CURRENT = {
  id: "dev-1", kind: "web", label: "Web", createdAt: "2026-08-01T09:00:00.000Z",
  lastSeenAt: "2026-08-20T09:00:00.000Z", ip: "", current: true, pushToken: null,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let originalFetch: typeof globalThis.fetch;
/** `GET /devices` resolvers parked while the request is "in flight". */
let holdDevices: boolean;
let heldDevices: Array<(r: Response) => void>;
let devicesStatus: number;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  holdDevices = false;
  heldDevices = [];
  devicesStatus = 200;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/api/devices")) {
      if (holdDevices) return new Promise<Response>((res) => { heldDevices.push(res); });
      return json(devicesStatus === 200 ? { items: [WEB_CURRENT] } : { error: "boom" }, devicesStatus);
    }
    if (method === "GET" && url.includes("/api/pair")) return json({ items: [] });
    return json({});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function mountSection(): Promise<HTMLElement> {
  const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(WithReport, { view: DevicesSection }))),
      }),
    );
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host!;
}

const buttonByText = (c: ParentNode, text: string): HTMLButtonElement | undefined =>
  [...c.querySelectorAll("button")].find((x) => x.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe("the devices list's three states", () => {
  it("while GET /devices is in flight the pane SAYS so — never a blank where the list belongs", async () => {
    holdDevices = true;
    const c = await mountSection();
    const status = c.querySelector('.set-note-inline[role="status"]');
    expect(status?.textContent, "the loading sentence").toContain("Loading your devices");
    // The subhead the list will keep is already standing — rows arriving replace only the
    // sentence, so nothing above or beside it moves.
    expect(c.textContent).toContain("Signed in");
    expect(c.textContent).not.toContain("This browser");

    // The answer lands: the sentence goes, the rows stand under the same subhead.
    await act(async () => {
      for (const res of heldDevices.splice(0)) res(json({ items: [WEB_CURRENT] }));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(c.querySelector('.set-note-inline[role="status"]')).toBeNull();
    expect(c.textContent).toContain("This browser");
  });

  it("a FAILED first read is a sentence and a retry, and the retry refetches", async () => {
    devicesStatus = 500;
    const c = await mountSection();
    expect(c.textContent).toContain("Your devices could not be loaded");
    const retry = buttonByText(c, "Try again");
    expect(retry, "the retry affordance").toBeTruthy();
    expect(c.textContent).not.toContain("This browser");

    devicesStatus = 200;
    await act(async () => { retry!.click(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(c.textContent).toContain("This browser");
    expect(c.textContent).not.toContain("could not be loaded");
    expect(buttonByText(c, "Try again")).toBeUndefined();
  });
});
