/** @vitest-environment jsdom */
/* @reads: packages/api/src/routes/desktop-host.ts packages/api/src/routes/local.ts packages/api/src/routes/mailboxes.ts */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import messages from "../../webapp/messages/en.json";
import type { GapLettersTransport } from "../../webapp/app/shell/GapLettersNotice";
import { BearerManager } from "../src/host-client/bearer.js";
import { HostGate } from "../src/host-client/HostGate.js";

/**
 * THE GAP OFFER ON A PAIRED DEVICE (the host door). The host counts the offer and serves
 * its answer (`desktopHostRoutes` spreads `localRoutes`), but the gate handed the shared shell no
 * transport, and the shell withholds an offer nothing can answer — so a device paired to the desktop
 * never drew it. Measured at the seam: the gate hands one in, and it rides the bearer to that route.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })) as never;

let shellProps: Record<string, unknown> | null = null;
vi.mock("../../webapp/app/shell/AppShell", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/shell/AppShell")>("../../webapp/app/shell/AppShell");
  return { ...real, AppShell: (props: Record<string, unknown>) => { shellProps = props; return null; } };
});
vi.mock("../../webapp/app/api-client", async () => {
  const real = await vi.importActual<typeof import("../../webapp/app/api-client")>("../../webapp/app/api-client");
  return { ...real, apiConfigured: () => false };
});

interface Sent { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } | undefined }
let sent: Sent[];
let status: number;
let root: Root | null = null;
let hostEl: HTMLDivElement | null = null;

beforeEach(() => {
  sent = [];
  status = 202;
  shellProps = null;
  window.localStorage.clear();
  (globalThis as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("the page opened a socket of its own");
  }) as typeof fetch;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  hostEl?.remove();
  hostEl = null;
  window.history.replaceState(null, "", "/");
});

async function gapTransport(): Promise<GapLettersTransport | undefined> {
  const bearer = new BearerManager({
    storage: window.localStorage,
    fetchImpl: (async (url: string, init?: unknown) => {
      sent.push({ url, init: init as Sent["init"] });
      const body = status === 409 ? { error: { code: "gap_changed" } } : { outcome: "pressed" };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as never,
  });
  bearer.adopt({ accessToken: "a1", refreshToken: "r1" }, { fresh: true });
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(HostGate, { bearer }) }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(shellProps, "the gate did not mount the shared shell on a live pairing").not.toBeNull();
  return shellProps!.gapLettersTransport as GapLettersTransport | undefined;
}

describe("the gap offer's answer on a device paired to this desktop", () => {
  it("the gate hands the shared shell a transport, beside the wires it already had", async () => {
    const answer = await gapTransport();
    expect(answer, "no gapLettersTransport: the shell withholds the offer on this door").toBeTypeOf("function");
    expect(shellProps!.consentTransport, "the consent wire was disturbed").toBeDefined();
    expect(shellProps!.junkWire, "the Junk wire was disturbed").toBeDefined();
  });

  it("rides the bearer to the host's own route, one answer per press", async () => {
    const answer = (await gapTransport())!;
    sent.length = 0;
    await answer("mb 1", { file: true, count: 2, strangers: 1 });
    expect(sent.map((s) => s.url)).toEqual(["/mailboxes/mb%201/gap-letters"]);
    expect(sent[0]!.init?.method).toBe("POST");
    expect(sent[0]!.init?.headers?.authorization).toBe("Bearer a1");
    expect(JSON.parse(sent[0]!.init!.body!)).toEqual({ file: true, count: 2, strangers: 1 });
  });

  it("a count that moved is a rejection carrying 409, which the notice words as changed", async () => {
    const answer = (await gapTransport())!;
    status = 409;
    await expect(answer("mb-1", { file: true, count: 2, strangers: 0 })).rejects.toMatchObject({ status: 409, code: "gap_changed" });
  });

  it("the route it asks for is served on the paired-device table", () => {
    expect(read("packages/api/src/routes/desktop-host.ts")).toContain("...localRoutes,");
    expect(read("packages/api/src/routes/local.ts")).toContain("...mailboxRoutes,");
    expect(read("packages/api/src/routes/mailboxes.ts")).toContain('pattern: "/mailboxes/:id/gap-letters"');
  });
});
