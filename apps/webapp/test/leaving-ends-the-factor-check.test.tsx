/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";

/**
 * LEAVING ENDS THE FACTOR CHECK, AS CANCEL DOES. The wall's Back and a pane switch in Settings take
 * the pane away while the step-up answer is still on the wire. That answer used to run the parked
 * verb anyway: the account was erased after the person had backed out, and the wall still said
 * nothing was deleted. Each arm holds the answer, leaves, lets it land and counts what went out;
 * the controls let it land with the pane still open, and the verb runs once. The real api-client
 * runs; only `fetch` is answered here.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rig = vi.hoisted(() => ({ wipes: 0 }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

/* The local wipe the erase runs after its 200: counted, never run against this page. */
vi.mock("../app/sign-out", () => ({
  forgetThisBrowser: async () => {
    rig.wipes += 1;
    return { remaining: [], inventoryComplete: true };
  },
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));

const EMAIL = "person@example.test";
const ERASE = "DELETE /api/account";
const CHANGE = "POST /api/auth/password";
const STEP_UP_REQUIRED = { error: { code: "step_up_required", message: "recent two-factor authentication required" } };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every request that left, as `METHOD /path`. */
let wire: string[] = [];
/** Lets the held step-up answer land. */
let release: (() => void) | null = null;
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const sent = (line: string): number => wire.filter((l) => l === line).length;

beforeEach(() => {
  wire = [];
  release = null;
  rig.wipes = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const line = `${(init?.method ?? "GET").toUpperCase()} ${new URL(String(input), "http://localhost").pathname}`;
    wire.push(line);
    if (line === "GET /api/auth/session") {
      return json(200, {
        user: { id: "u1", accountId: "acct-under-test", email: EMAIL, twofaEnrolled: { webauthn: false, totp: true } },
        scope: "full",
      });
    }
    // The first try of each verb meets a closed window; the one the factor sends goes through.
    if (line === ERASE) {
      return sent(ERASE) === 1
        ? json(403, STEP_UP_REQUIRED)
        : json(200, { erased: true, retained: "one billing row", subscription: "none" });
    }
    if (line === CHANGE) return sent(CHANGE) === 1 ? json(403, STEP_UP_REQUIRED) : json(200, { revoked: 1 });
    if (line === "POST /api/auth/step-up/totp") {
      await new Promise<void>((r) => {
        release = r;
      });
      return json(200, { ok: true });
    }
    return json(200, {});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  // A control that erased latched this tab on the erased account; the next arm starts unlatched.
  (await import("../app/shell/account-erased.js")).clearAccountErased();
  vi.restoreAllMocks();
});

async function mountNode(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
  });
  return host;
}

async function mountWall(): Promise<HTMLElement> {
  const { AccessLock } = await import("../app/(product)/mailbox/AccessLock.js");
  return mountNode(h(AccessLock, { facts: { reason: "payment_required" as const } }));
}

/** Settings → Account with CloudShell's own node: the password change above the account's cards. */
async function mountSettings(): Promise<HTMLElement> {
  const { SettingsView } = await import("../app/views/SettingsView.js");
  const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
  const { PasswordSection } = await import("../app/(product)/mailbox/PasswordSection.js");
  return mountNode(h(SettingsView, {
    notifications: null, tags: [], tagCounts: {}, initialPane: "account",
    accountSection: h(React.Fragment, null, h(PasswordSection), h(AccountSection)),
  }));
}

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function submit(form: Element): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const button = (c: ParentNode, label: string): HTMLButtonElement => {
  const found = [...c.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === label);
  expect(found, `exactly one button reading "${label}"`).toHaveLength(1);
  return found[0]!;
};

/** Types the address back and presses Delete: the closed window opens the prompt. */
async function eraseToThePrompt(c: HTMLElement): Promise<void> {
  await waitFor(() => c.querySelector("#acct-typed") != null, "the typed-address step");
  await type(c.querySelector<HTMLInputElement>("#acct-typed")!, EMAIL);
  await submit(c.querySelector("#acct-typed")!.closest("form")!);
}

async function changeToThePrompt(c: HTMLElement): Promise<void> {
  await waitFor(() => c.querySelector("#pwc-current") != null, "the password form");
  await type(c.querySelector<HTMLInputElement>("#pwc-current")!, "old-correct-horse-password");
  await type(c.querySelector<HTMLInputElement>("#pwc-next")!, "new-battery-staple-password");
  await type(c.querySelector<HTMLInputElement>("#pwc-repeat")!, "new-battery-staple-password");
  await submit(c.querySelector("#pwc-current")!.closest("form")!);
}

/** Types the code and presses Verify; the answer stays on the wire until `land`. */
async function verifyHeld(c: HTMLElement): Promise<void> {
  await waitFor(() => c.querySelector("#stepup-code") != null, "the step-up prompt");
  await type(c.querySelector<HTMLInputElement>("#stepup-code")!, "123456");
  await submit(c.querySelector("#stepup-code")!.closest("form")!);
  await waitFor(() => release !== null, "the step-up answer held on the wire");
}

/** The held answer lands, and whatever it runs gets a few turns to run. */
async function land(): Promise<void> {
  await act(async () => {
    release!();
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function erasedOwner(): Promise<string | null> {
  return (await import("../app/shell/account-erased.js")).accountErasedOwner();
}

describe("the wall's Back while the factor is checked", () => {
  it("the erase: no DELETE /account after Back, nothing wiped, and the wall still true", async () => {
    const c = await mountWall();
    await click(button(c, en.accessLock.deleteNow));
    await eraseToThePrompt(c);
    await verifyHeld(c);
    expect(sent(ERASE), "the press met the closed window first").toBe(1);

    await click(button(c, en.accessLock.back));
    expect(c.querySelector('[data-testid="step-up-prompt"]'), "Back took the prompt away").toBeNull();
    await land();

    expect(sent(ERASE), "DELETE /account went out after Back").toBe(1);
    expect(rig.wipes, "this browser's copy was wiped for an erase nobody confirmed").toBe(0);
    expect(await erasedOwner(), "the tab latched an erasure").toBeNull();
    expect(c.textContent).toContain(en.accessLock.kept);
    button(c, en.accessLock.deleteNow);
  });

  it("the password change: not sent again after Back", async () => {
    const c = await mountWall();
    await click(button(c, en.accessLock.changePassword));
    await changeToThePrompt(c);
    await verifyHeld(c);
    expect(sent(CHANGE)).toBe(1);

    await click(button(c, en.accessLock.back));
    expect(c.querySelector('[data-testid="step-up-prompt"]'), "Back took the prompt away").toBeNull();
    await land();

    expect(sent(CHANGE), "POST /auth/password went out after Back").toBe(1);
    button(c, en.accessLock.changePassword);
  });

  it("CONTROL: the answer lands with the pane open, and the erase runs once", async () => {
    const c = await mountWall();
    await click(button(c, en.accessLock.deleteNow));
    await eraseToThePrompt(c);
    await verifyHeld(c);
    await land();

    await waitFor(() => c.textContent!.includes(en.account.doneTitle), "the erasure receipt");
    expect(sent(ERASE)).toBe(2);
    expect(rig.wipes).toBe(1);
    expect(await erasedOwner()).toBe("acct-under-test");
  });

  it("CONTROL: the answer lands with the pane open, and the change is sent once more", async () => {
    const c = await mountWall();
    await click(button(c, en.accessLock.changePassword));
    await changeToThePrompt(c);
    await verifyHeld(c);
    await land();

    await waitFor(() => c.textContent!.includes("1 other session was signed out"), "the change's receipt");
    expect(sent(CHANGE)).toBe(2);
  });
});

/* The prompt alone, without a host's own guard: every host that parks a verb behind it (devices,
   mailboxes, desktop link, approval, join) leans on this. */
describe("the prompt itself", () => {
  async function mountPrompt(calls: string[]): Promise<{ c: HTMLElement; drop: () => void }> {
    const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
    let drop: () => void = () => {};
    function Host(): React.ReactElement | null {
      const [shown, setShown] = React.useState(true);
      drop = () => setShown(false);
      return shown
        ? h(StepUpPrompt, {
          onVerified: () => calls.push("verified"),
          onCancel: () => calls.push("cancel"),
          onDiscarded: () => calls.push("discarded"),
        })
        : null;
    }
    const c = await mountNode(h(Host));
    return { c, drop: () => drop() };
  }

  it("taken away while the answer is held, it never calls onVerified", async () => {
    const calls: string[] = [];
    const { c, drop } = await mountPrompt(calls);
    await verifyHeld(c);

    await act(async () => {
      drop();
    });
    await land();

    expect(calls, "a prompt that is gone ran the parked verb").not.toContain("verified");
  });

  it("CONTROL: left in place, the same answer calls onVerified once", async () => {
    const calls: string[] = [];
    const { c } = await mountPrompt(calls);
    await verifyHeld(c);
    await land();

    expect(calls).toEqual(["verified"]);
  });
});

describe("Settings: another pane while the factor is checked", () => {
  /** A nav entry that is not the open one. */
  const otherPane = (c: HTMLElement): HTMLButtonElement =>
    c.querySelector<HTMLButtonElement>(".set-nav button:not(.on)")!;

  it("the erase: no DELETE /account after the switch", async () => {
    const c = await mountSettings();
    await eraseToThePrompt(c);
    await verifyHeld(c);

    await click(otherPane(c));
    expect(c.querySelector('[data-testid="step-up-prompt"]'), "the switch took the pane away").toBeNull();
    await land();

    expect(sent(ERASE), "DELETE /account went out after the switch").toBe(1);
    expect(rig.wipes).toBe(0);
    expect(await erasedOwner()).toBeNull();
  });

  it("the password change: not sent again after the switch", async () => {
    const c = await mountSettings();
    await changeToThePrompt(c);
    await verifyHeld(c);

    await click(otherPane(c));
    expect(c.querySelector('[data-testid="step-up-prompt"]'), "the switch took the pane away").toBeNull();
    await land();

    expect(sent(CHANGE), "POST /auth/password went out after the switch").toBe(1);
  });
});
