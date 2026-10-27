/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as shell from "./fixtures/cloud-confirm-shell";

/**
 * THE WAKE STREAM THROUGH THE REAL `CloudShell`, on the warm path every reload takes (a remembered
 * owner, a mirror on the device). The confirm that opens the sync gate dials the stream, with no
 * tab flip. And SSE-WEB-STREAM-LATCHED-DEAD-BY-A-STALE-INSTANCE: a stream refused at its re-dial,
 * then the poll's 402 raises the wall, which REPLACES the mail shell; the lift mounts a fresh shell
 * whose confirm dials a NEW stream. While the wall stands nothing dials.
 */

/** The browser's `EventSource`, reduced to what the scheduler reads; every construction counted. */
class FakeEventSource {
  static made: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(readonly url: string) { FakeEventSource.made.push(this); }
  addEventListener(type: string, l: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(l);
    this.listeners.set(type, set);
  }
  close(): void { this.closed = true; this.readyState = 2; }
  private fire(type: string): void { for (const l of [...(this.listeners.get(type) ?? [])]) l(); }
  /** The server admitted the stream: headers, then the `ready` frame. */
  open(): void { this.readyState = 1; this.fire("open"); this.fire("ready"); }
  /** A non-200 at a (re-)dial: the browser stops for good. */
  refuse(): void { this.readyState = 2; this.fire("error"); }
}

const OWNER = shell.ACCOUNT;
const CLOSED = {
  metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, aiEnabled: false,
  lifecycle: {
    state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
    closedAt: "2026-08-25T00:00:00.000Z", erasureAt: "2026-10-23T00:00:00.000Z",
    erasedAt: null, formerlyPaid: false,
  },
  manageUrl: "https://plane.ohmail.app/manage?token=t", exportPath: "/account/export",
};
const OPEN = { metered: true, access: "open", canAddMailbox: true, mailboxes: 5, aiEnabled: true };
const jsonOf = (b: unknown, status = 200): Response =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const refused402 = (): Response => jsonOf({
  error: { code: "subscription_required", message: "not active", details: { reason: "payment_required", lifecycle: CLOSED.lifecycle } },
}, 402);

let access: () => Response = () => jsonOf(OPEN);
let walled = false;
let asked: string[] = [];

beforeEach(async () => {
  (await import("../app/api-client")).forgetAccess();
  shell.installConfirmEnv();
  shell.scriptSession(() => shell.sessionFull());
  shell.rememberOwner(OWNER);
  localStorage.clear();
  sessionStorage.clear();
  access = () => jsonOf(OPEN);
  walled = false;
  FakeEventSource.made = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  const base = globalThis.fetch;
  asked = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${Math.round((Date.now() - Date.parse(shell.ISO)) / 1000)}s ${new URL(url, "https://ohmail.app").pathname}${walled ? "!" : ""}`);
    if (url.includes("/auth/refresh")) return new Response(null, { status: 204 });
    if (url.includes("/account/access")) return access();
    if (walled && (url.includes("/mailboxes") || url.includes("/sync"))) return refused402();
    return base(input as RequestInfo, init);
  }) as unknown as typeof globalThis.fetch;
}, 60_000);
afterEach(async () => {
  await shell.teardownConfirmEnv();
  vi.unstubAllGlobals();
}, 60_000);

describe("the wall replaces the mail shell, so the lift streams again", () => {
  it("a warm mount dials its stream when the confirm opens the gate, with no tab flip", { timeout: 60_000 }, async () => {
    await shell.mountCloudShell();
    await shell.tick(5_000);
    expect(document.body.querySelector(".app-root"), "the premise: the mail opened").not.toBeNull();
    expect(shell.sessionCalls(), "the premise: the confirm was asked").toBeGreaterThanOrEqual(1);
    expect(FakeEventSource.made, "the warm mount held no stream until a tab flip").toHaveLength(1);
    expect(new URL(FakeEventSource.made[0]!.url, "https://ohmail.test").pathname).toBe("/api/events");
  });

  it("a stream latched dead at its re-dial, the wall, then the payment: the lift dials a NEW stream, and nothing dials while the wall stands", { timeout: 60_000 }, async () => {
    const { RETURN_DEBOUNCE_MS } = await import("../app/shell/wall-lift");
    await shell.mountCloudShell();
    await shell.tick(5_000);
    expect(document.body.querySelector(".app-root"), "the premise: the mail opened").not.toBeNull();
    expect(FakeEventSource.made, "the premise: the open shell dialled its stream").toHaveLength(1);
    const first = FakeEventSource.made[0]!;
    await shell.act(async () => { first.open(); });
    await shell.tick(1_000);
    // The refusal close, then the browser's re-dial meets the admission 402: latched dead.
    walled = true;
    access = () => jsonOf(CLOSED);
    await shell.act(async () => { first.refuse(); });
    // Past the client's stale-refusal window after the first paint's open verdict (60 s).
    await shell.tick(75_000);
    expect(document.body.querySelector(".wall-card"), `the poll's 402 did not raise the wall: ${asked.join(" ")}`).not.toBeNull();
    expect(first.closed, "the dead stream was left open under the wall").toBe(true);
    await shell.tick(2 * 60_000);
    expect(FakeEventSource.made, "a stream was dialled while the account was refused").toHaveLength(1);
    // Paid elsewhere: the wall's own return read answers open.
    access = () => jsonOf(OPEN);
    walled = false;
    await shell.tick(RETURN_DEBOUNCE_MS);
    await shell.act(async () => { window.dispatchEvent(new Event("focus")); });
    await shell.tick(5_000);
    expect(document.body.querySelector(".wall-card"), "the wall stood over an open verdict").toBeNull();
    expect(document.body.querySelector(".app-root")).not.toBeNull();
    expect(FakeEventSource.made, "the lift dialled no new stream").toHaveLength(2);
    expect(FakeEventSource.made[1]!.closed).toBe(false);
  });
});
