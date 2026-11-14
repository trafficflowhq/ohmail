/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * A CANCEL DURING THE STEP-UP IS NOT UNDONE BY THE FACTOR LANDING. The three panes used to confirm
 * with a sign-in, and a step back while that login was on the wire was followed by the pane
 * jumping to the factor step. The confirm is now `StepUpPrompt` over a parked write: each pane
 * holds the factor open, cancels, lets it land, and must stay where the person went with the
 * write never sent, saying nothing was done; the control lets it land untouched and the write runs.
 */

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mb = en.mailboxes as unknown as Record<string, string>;
const link = en.linkDesktop as unknown as Record<string, string>;

/** The doors every arm shares, plus the one promise the test holds open. */
const rig = vi.hoisted(() => ({
  calls: [] as string[],
  settle: null as null | ((v: unknown) => void),
  inFlight: null as null | Promise<unknown>,
  listed: [] as unknown[],
  /** Each gated write is refused once, for a closed step-up window: that refusal opens the prompt. */
  mintRefusals: 0,
  pairRefusals: 0,
  writeRefusals: {} as Record<string, number>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({
    state: { mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null } } as unknown as MailState,
    refresh: () => {},
  }),
}));

vi.mock("../app/sign-out", () => ({
  forgetThisBrowser: async () => ({ remaining: [], inventoryComplete: true }),
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));

vi.mock("../app/hello", () => ({
  SELF_HOST_BUILD: false,
  serverHello: async () => ({ flavor: "managed", features: { pairing: true } }),
}));

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  /** A call whose response the TEST lands, and which records that it was made. */
  const held = (name: string): Promise<unknown> => {
    rig.calls.push(name);
    const p = new Promise<unknown>((resolve) => { rig.settle = resolve; });
    rig.inFlight = p;
    return p;
  };
  const noted = <T,>(name: string, value: T) => async (): Promise<T> => {
    if ((rig.writeRefusals[name] ?? 0) > 0) {
      rig.writeRefusals[name] -= 1;
      throw new actual.ApiError(403, "step_up_required", "recent two-factor authentication required");
    }
    rig.calls.push(name);
    return value;
  };
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    assertPasskey: async () => ({ id: "credential" }),
    pendApiOwner: () => {},
    auth: {
      desktopLink: async () => {
        if (rig.mintRefusals > 0) {
          rig.mintRefusals -= 1;
          throw new actual.ApiError(403, "step_up_required", "recent 2FA re-assertion required");
        }
        rig.calls.push("auth.desktopLink");
        return { code: "ABCD-EFGH", expiresIn: 300 };
      },
      session: async () => ({
        user: {
          accountId: "acct", email: "person@example.test", emailVerified: true,
          twofaEnrolled: { webauthn: false, totp: true },
        },
        scope: "full",
      }),
      login: () => held("login"),
      totpVerify: () => held("totpVerify"),
      recoveryVerify: () => held("recoveryVerify"),
      webauthnAssertOptions: async () => ({ options: {} }),
      webauthnAssertVerify: () => held("webauthnAssertVerify"),
      stepUpTotp: () => held("stepUpTotp"),
      stepUpWebauthnOptions: async () => ({ options: {} }),
      stepUpWebauthnVerify: () => held("stepUpWebauthnVerify"),
    },
    billing: { subscription: async () => ({ status: "active", plan: "pro", credits: 100 }) },
    account: {
      access: async () => ({ metered: false }),
      erase: noted("account.erase", { erased: true, retained: "billing records only", subscription: "none" }),
    },
    mailboxes: {
      list: async () => ({ items: rig.listed }),
      create: noted("mailboxes.create", {}),
      update: noted("mailboxes.update", {}),
      remove: noted("mailboxes.remove", undefined),
      resync: async () => undefined,
      organizer: noted("mailboxes.organizer", { role: "organizer" }),
      takeover: noted("mailboxes.takeover", { role: "organizer" }),
    },
    devices: {
      list: async () => ({ items: [] }),
      revoke: noted("devices.revoke", undefined),
      revokeWebSessions: noted("devices.revokeWebSessions", undefined),
    },
    pair: {
      mintDevice: async () => {
        if (rig.pairRefusals > 0) {
          rig.pairRefusals -= 1;
          throw new actual.ApiError(403, "step_up_required", "step-up verification required");
        }
        rig.calls.push("pair.mintDevice");
        return { id: "pt-1", token: "tok-pair", grant: "device-pair", label: "", expiresAt: "2026-09-16T09:05:00.000Z" };
      },
    },
  };
});

let roots: Root[] = [];

beforeEach(() => {
  rig.calls = [];
  rig.settle = null;
  rig.inFlight = null;
  rig.listed = [];
  rig.mintRefusals = 1;
  rig.pairRefusals = 1;
  rig.writeRefusals = { "mailboxes.update": 1, "account.erase": 1 };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); });
}

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function render(node: React.ReactElement): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC", now: new Date("2026-09-16T09:00:00.000Z"),
      children: h(ToastHost, null, node),
    }));
  });
  await settle();
  return host;
}

function byText(el: HTMLElement, text: string): HTMLElement | null {
  return [...el.querySelectorAll("button, a")]
    .find((n) => (n.textContent ?? "").trim() === text) as HTMLElement | undefined ?? null;
}

/** One control, by its own label, and a refusal when the screen offers two or none. */
function only(el: HTMLElement, selector: string, text: string): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>(selector)]
    .filter((n) => (n.textContent ?? "").trim() === text);
  expect(found, `exactly one "${text}" control`).toHaveLength(1);
  return found[0]!;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await settle();
}

async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field the walk needs is not on screen").toBeTruthy();
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}

async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

/** Let the held factor land, the way it lands in a browser: after the press. */
async function landTheFactor(): Promise<void> {
  const settleIt = rig.settle!;
  expect(settleIt, "no factor was in flight to land").toBeTruthy();
  await act(async () => {
    settleIt({ ok: true });
    await rig.inFlight;
    await new Promise((r) => setTimeout(r, 15));
  });
  await settle();
}

/** At the prompt a closed window opened: send the code and leave it in flight. */
async function factorInFlight(el: HTMLElement): Promise<void> {
  await waitFor(() => el.querySelector("#stepup-code") != null, "the step-up prompt");
  await typeInto(el.querySelector("#stepup-code"), "123456");
  await submit(el.querySelector("#stepup-code")!.closest("form"));
  await waitFor(() => rig.settle != null, "the factor to be in flight");
}

const dev = en.devices as unknown as Record<string, string>;

const buttonNamed = (el: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll<HTMLButtonElement>("button")].filter((b) => (b.textContent ?? "").trim() === text);
  expect(found, `exactly one "${text}" button`).toHaveLength(1);
  return found[0]!;
};

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test", displayName: null,
  status: "connected", lastSyncAt: "2026-09-15T11:00:00.000Z", createdAt: "2026-09-15T10:00:00.000Z",
  ...over,
} as MailboxDTO);


const account = en.account as unknown as Record<string, string>;

describe("MailboxSection: Cancel during the step-up of an edit", () => {
  async function toTheFactorInFlight(): Promise<HTMLElement> {
    rig.listed = [dto()];
    const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
    const el = await render(h(MailboxSection));
    await click(byText(el, mb.edit!)!);
    await typeInto(el.querySelector("#mb-edit-pass"), "new-app-password-fixture");
    await submit(el.querySelector("#mb-edit-pass")!.closest("form"));
    await factorInFlight(el);
    return el;
  }

  it("Cancel, then the factor lands: the parked PATCH never runs, the edit form is back as typed", async () => {
    const el = await toTheFactorInFlight();
    await click(buttonNamed(el, dev.cancel!));
    await landTheFactor();
    expect(rig.calls, "the parked edit ran after Cancel").not.toContain("mailboxes.update");
    expect(el.querySelector<HTMLInputElement>("#mb-edit-pass")?.value, "Cancel threw the typed password away")
      .toBe("new-app-password-fixture");
    expect(el.textContent).toContain(mb.cancelledNothingChanged);
  }, 20000);

  it("control: a factor nobody cancelled runs the parked PATCH", async () => {
    const el = await toTheFactorInFlight();
    await landTheFactor();
    await waitFor(() => rig.calls.includes("mailboxes.update"), "the parked edit");
    expect(el.textContent).not.toContain(mb.cancelledNothingChanged);
  }, 20000);
});

describe("AccountSection: Cancel during the step-up of the erase", () => {
  async function toTheFactorInFlight(): Promise<HTMLElement> {
    const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
    const el = await render(h(AccountSection));
    await waitFor(() => el.querySelector("#acct-typed") != null, "the facts step");
    await typeInto(el.querySelector("#acct-typed"), "person@example.test");
    await submit(el.querySelector("form.acct-confirm"));
    await factorInFlight(el);
    return el;
  }

  it("Cancel, then the factor lands: DELETE /account is never sent, and the pane says nothing was erased", async () => {
    const el = await toTheFactorInFlight();
    await click(buttonNamed(el, dev.cancel!));
    await landTheFactor();
    expect(rig.calls, "the parked erase ran after Cancel").not.toContain("account.erase");
    expect(el.textContent).not.toContain(account.doneTitle);
    expect(el.textContent).toContain(account.cancelledNothingErased);
  }, 20000);

  it("control: a factor nobody cancelled erases and shows the receipt", async () => {
    const el = await toTheFactorInFlight();
    await landTheFactor();
    await waitFor(() => (el.textContent ?? "").includes(account.doneTitle!), "the receipt");
    expect(rig.calls).toContain("account.erase");
  }, 20000);
});

describe("LinkDesktopScreen: Cancel during the step-up of the mint", () => {
  async function toTheFactorInFlight(): Promise<HTMLElement> {
    const { LinkDesktopScreen } = await import("../app/(product)/link-desktop/LinkDesktopScreen.js");
    const el = await render(h(LinkDesktopScreen, {}));
    await click(byText(el, link.mint!)!);
    await factorInFlight(el);
    return el;
  }

  it("Cancel stays pressable, and a factor landing after it mints nothing", async () => {
    const el = await toTheFactorInFlight();
    const cancel = buttonNamed(el, dev.cancel!);
    expect(cancel.disabled, "a person who changes their mind during the check must be able to").toBe(false);
    await click(cancel);
    await landTheFactor();
    expect(rig.calls, "the parked mint ran after Cancel").not.toContain("auth.desktopLink");
    expect(el.querySelector("#stepup-code"), "the landing factor reopened the prompt").toBeNull();
    expect(el.textContent).toContain(link.cancelledNothingMinted);
  }, 20000);

  it("control: a factor nobody cancelled mints the code", async () => {
    const el = await toTheFactorInFlight();
    await landTheFactor();
    await waitFor(() => rig.calls.includes("auth.desktopLink"), "the mint");
    await waitFor(() => (el.textContent ?? "").includes("ABCD-EFGH"), "the code on screen");
  }, 20000);
});
