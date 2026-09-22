/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * THE ONE-CONFIRM SIGN-IN, on the screen: "Sign in with browser" asks the engine for a request,
 * opens the approval page BY ITS ID (never a URL), and waits while the engine polls — no code to
 * copy, and on a door already chosen no address either. A busy server is a wait with its own line,
 * a request that runs out says so and stops polling, a refusal ends it with the engine's sentence,
 * and a hosted service with no approval door drops to the code path by name.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

let asked: { command: string; payload?: Record<string, unknown> }[] = [];
/** What `POST /cloud/signin/approval` answers. */
let approval: () => Uint8Array;
/** What each `{approval: true}` poll answers, in order; the last repeats. */
let polls: Uint8Array[];

const pending = (note?: string): Uint8Array =>
  encode(202, JSON.stringify({ status: "pending", retryAfterMs: 2000, ...(note ? { note } : {}) }));

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
  approval = () => encode(200, JSON.stringify({ approvalId: ID, expiresIn: 300 }));
  polls = [pending()];
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => next++,
    invoke: async (command, payload) => {
      asked.push({ command, payload });
      if (command === "engine_configure") return { state: "starting", mode: "cloud" };
      if (command === "engine_status") {
        return { state: "serving", mode: "cloud", mailboxId: "mbx-1", credentialState: "absent" };
      }
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/cloud/signin/approval") return approval();
        if (url === "/cloud/signin") return polls.length > 1 ? polls.shift()! : polls[0]!;
        return encode(404, "{}", "Not Found");
      }
      if (command === "open_link") return null;
      if (command === "plugin:event|listen") return next;
      throw new Error(`unexpected command ${command}`);
    },
  };
});

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(cloudAction: "configure" | "signIn"): Promise<{ el: HTMLElement; entered: unknown[] }> {
  vi.resetModules();
  const { DoorChooser } = await import("../src/DoorChooser.js");
  const entered: unknown[] = [];
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(h(DoorChooser, { start: "cloud", cloudAction, onEntered: (r: unknown) => entered.push(r) }));
  });
  return { el: mountPoint, entered };
}

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
  if (found.length !== 1) throw new Error(`expected one button saying "${label}", found ${found.length}`);
  return found[0]!;
}
const click = async (b: HTMLButtonElement): Promise<void> => {
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const elapse = async (ms: number): Promise<void> => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const pollsMade = (): number =>
  asked.filter((a) => a.command === "engine_request" && a.payload?.url === "/cloud/signin").length;

describe("the browser path is one confirm, not a code", () => {
  it("on a door already chosen: no address, the page opened by its request id, signed in on approval", async () => {
    polls = [pending(), pending(), encode(200, JSON.stringify({ status: "signed_in" }))];
    const { el, entered } = await mount("signIn");
    await click(buttonSaying(el, "Sign in with browser"));
    expect(el.querySelector("#cloud-address"), "the approval asked for an address").toBeNull();
    expect(el.querySelector("#cloud-handoff"), "the approval asked for a code").toBeNull();

    await click(buttonSaying(el, "Open ohmail.app"));
    expect(asked.some((a) => a.command === "engine_configure"), "a chosen door was reconfigured").toBe(false);
    const opened = asked.filter((a) => a.command === "open_link");
    expect(opened.map((a) => a.payload)).toEqual([{ key: "approve", request: ID }]);
    expect(el.textContent).toContain("Waiting for your browser…");

    await elapse(2000);
    await elapse(2000);
    expect(entered).toHaveLength(0);
    await elapse(2000);
    expect(entered).toHaveLength(1);
    expect(pollsMade()).toBe(3);
  });

  it("on a fresh door: the address names the mailbox it will hold, and the door is configured first", async () => {
    polls = [encode(200, JSON.stringify({ status: "signed_in" }))];
    const { el, entered } = await mount("configure");
    await click(buttonSaying(el, "Sign in with browser"));
    const label = el.querySelector('label[for="cloud-address"]')?.textContent ?? "";
    expect(label).toMatch(/^The ohmail mailbox this .+ will hold$/);
    await type(el, "cloud-address", "mila@ohmail.app");
    await click(buttonSaying(el, "Open ohmail.app"));
    const order = asked.map((a) => (a.command === "engine_request" ? String(a.payload!.url) : a.command));
    expect(order.indexOf("engine_configure")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("engine_configure")).toBeLessThan(order.indexOf("/cloud/signin/approval"));
    await elapse(2000);
    expect(entered).toHaveLength(1);
  });

  it("a busy server is a wait with its own line, never a refusal", async () => {
    polls = [pending("busy"), encode(200, JSON.stringify({ status: "signed_in" }))];
    const { el, entered } = await mount("signIn");
    await click(buttonSaying(el, "Sign in with browser"));
    await click(buttonSaying(el, "Open ohmail.app"));
    await elapse(2000);
    expect(el.textContent).toContain("The ohmail server is busy. Still waiting.");
    await elapse(2000);
    expect(entered).toHaveLength(1);
  });

  it("the request's own lifetime ends the wait, with a sentence, and the polling stops", async () => {
    approval = () => encode(200, JSON.stringify({ approvalId: ID, expiresIn: 5 }));
    const { el, entered } = await mount("signIn");
    await click(buttonSaying(el, "Sign in with browser"));
    await click(buttonSaying(el, "Open ohmail.app"));
    await elapse(2000);
    await elapse(2000);
    await elapse(2000);
    expect(el.textContent).toContain("This request expired before it was confirmed. Start again.");
    const made = pollsMade();
    await elapse(10_000);
    expect(pollsMade(), "the loop kept polling past the request's lifetime").toBe(made);
    expect(entered).toHaveLength(0);
  });

  it("a refusal ends the request with the engine's sentence", async () => {
    polls = [encode(410, JSON.stringify({ error: { code: "approval_denied", message: "This request was declined in the browser." } }), "Gone")];
    const { el } = await mount("signIn");
    await click(buttonSaying(el, "Sign in with browser"));
    await click(buttonSaying(el, "Open ohmail.app"));
    await elapse(2000);
    expect(el.textContent).toContain("This request was declined in the browser.");
    const made = pollsMade();
    await elapse(10_000);
    expect(pollsMade()).toBe(made);
  });

  it("no approval door on the hosted side: the code path, by name", async () => {
    approval = () => encode(409, JSON.stringify({
      error: { code: "approval_not_offered", message: "Your ohmail Cloud does not offer browser approval yet. Type a code instead." },
    }), "Conflict");
    const { el } = await mount("signIn");
    await click(buttonSaying(el, "Sign in with browser"));
    await click(buttonSaying(el, "Open ohmail.app"));
    expect(el.textContent).toContain("Your ohmail Cloud does not offer browser approval yet. Type a code instead.");
    expect(el.querySelector("#cloud-handoff"), "the code field did not appear").not.toBeNull();
    expect(asked.some((a) => a.command === "open_link")).toBe(false);
  });

  it("Type a code instead stops the wait: no poll after the press", async () => {
    const { el } = await mount("signIn");
    await click(buttonSaying(el, "Sign in with browser"));
    await click(buttonSaying(el, "Open ohmail.app"));
    await elapse(2000);
    await click(buttonSaying(el, "Type a code instead"));
    const made = pollsMade();
    await elapse(10_000);
    expect(pollsMade()).toBe(made);
    expect(el.querySelector("#cloud-handoff")).not.toBeNull();
  });
});
