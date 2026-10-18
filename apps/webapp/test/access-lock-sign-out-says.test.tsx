/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "@ohmail/ui";
import messages from "../messages/en.json";
import type { SignOutResult } from "../app/sign-out";

/**
 * THE LOCK SCREEN'S SIGN-OUT SAYS WHAT HAPPENED (ACCESS-LOCK-REFUSED-SIGN-OUT-IS-SILENT). A refused
 * or unfinished sign-out used to give the button back and change nothing on the screen, and a
 * finished one left the lock standing. The three sentences are the account pane's, through ONE
 * reader (`signOutTrouble`) the pane, the error page and the lock share, in the pane's order.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as never;

const FINISHED: SignOutResult = { cleared: true, remaining: [], inventoryComplete: true, serverRefused: null };
let outcome: SignOutResult = FINISHED;
vi.mock("../app/sign-out", () => ({ signOut: vi.fn(async () => outcome) }));

const account = (messages as unknown as { account: Record<string, string> }).account;
let navigatedTo: string | null = null;
let host: HTMLDivElement;
let root: Root;
const realLocation = window.location;

beforeEach(() => {
  navigatedTo = null;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { get href() { return document.URL; }, assign: (url: string) => { navigatedTo = url; } },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

async function pressSignOut(): Promise<string[]> {
  const { AccessLock } = await import("../app/(product)/mailbox/AccessLock");
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, children: h(ThemeProvider, { children: h(AccessLock, { facts: { reason: "payment_required" } }) }),
    }));
  });
  const out = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Sign out");
  expect(out).toHaveLength(1);
  await act(async () => { out[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
}

describe("the lock screen's sign-out", () => {
  /* The browser is wiped and marked `signed_out_pending`, so `/` sends it to the sign-in page,
     which finishes the sign-out at the door behind its form (`login-finishes-sign-out`). Standing
     here kept the lock over a client that could no longer ask anything (`resume-never-loops`). */
  it("a refusal on the server leaves for the front door that finishes it, claiming nothing", async () => {
    outcome = { ...FINISHED, serverRefused: "the server said no." };
    const alerts = await pressSignOut();
    expect(alerts, "a refused sign-out claimed an ending here").toEqual([]);
    expect(navigatedTo, "a refused sign-out stood over a client that can no longer ask").toBe("/");
  });

  it("a blocked wipe and an unverifiable one are said as the account pane says them", async () => {
    outcome = { ...FINISHED, cleared: false, remaining: ["ohmail-mirror"] };
    expect(await pressSignOut()).toEqual([account.signOutBlocked!]);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    outcome = { ...FINISHED, cleared: false, inventoryComplete: false };
    expect(await pressSignOut(), "the unverifiable arm was read as a blocked one").toEqual([account.signOutUnverified!]);
    expect(navigatedTo).toBeNull();
  });

  /* Accepted as its own defect: the lock's comment said `signOut` navigates on success, which it
     never did, so a finished sign-out left the lock standing. Red at base on this case alone. */
  it("a finished sign-out leaves for the sign-in page and says nothing", async () => {
    outcome = FINISHED;
    expect(await pressSignOut()).toEqual([]);
    expect(navigatedTo, "a finished sign-out left the lock standing").toBe("/login");
  });
});

describe("the one reader, in the account pane's order", () => {
  it("unverifiable before blocked before refused, and nothing for a finished one", async () => {
    const { signOutTrouble } = await import("../app/sign-out-trouble");
    expect(signOutTrouble({ cleared: false, remaining: [], inventoryComplete: false, serverRefused: "x" }))
      .toEqual({ key: "signOutUnverified" });
    expect(signOutTrouble({ cleared: false, remaining: ["a"], inventoryComplete: true, serverRefused: "x" }))
      .toEqual({ key: "signOutBlocked" });
    expect(signOutTrouble({ ...FINISHED, serverRefused: "x" })).toEqual({ key: "signOutServerRefused", reason: "x" });
    expect(signOutTrouble(FINISHED)).toBeNull();
  });
});
