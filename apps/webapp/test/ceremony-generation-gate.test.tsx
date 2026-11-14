/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ToastHost } from "@ohmail/ui";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * BACK AND CANCEL END THE CEREMONY EVERYWHERE, NOT ONLY AT THE ACCOUNT ERASE.
 *
 * `account-erase-cancel.test.tsx` holds the same invariant for the one irreversible act and the
 * census of every post-verify site in the app. Every confirm is now `StepUpPrompt` over a parked
 * write, so this drives its hosts: a factor that lands after the person pressed Cancel removes no
 * mailbox, mints no pairing code and runs no parked verb — and each surface SAYS so, because a
 * silent discard leaves somebody looking at a screen that is identical either way.
 *
 * Every arm holds the verify open with a promise the TEST settles: the whole defect lives in the
 * window between the press and the response, so a stub that resolves by itself cannot reach it.
 */

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mb = en.mailboxes as unknown as Record<string, string>;
const link = en.linkDesktop as unknown as Record<string, string>;
const dev = en.devices as unknown as Record<string, string>;

/** The doors every arm shares, plus the one promise the test holds open. */
const rig = vi.hoisted(() => ({
  calls: [] as string[],
  settle: null as null | ((v: unknown) => void),
  inFlight: null as null | Promise<unknown>,
  listed: [] as unknown[],
  /** Each mint is refused once, for a closed step-up window: that refusal opens the ceremony. */
  mintRefusals: 0,
  pairRefusals: 0,
  removeRefusals: 0,
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
      login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
      totpVerify: () => held("totpVerify"),
      recoveryVerify: () => held("recoveryVerify"),
      webauthnAssertOptions: async () => ({ options: {} }),
      webauthnAssertVerify: () => held("webauthnAssertVerify"),
      stepUpTotp: () => held("stepUpTotp"),
      stepUpWebauthnOptions: async () => ({ options: {} }),
      stepUpWebauthnVerify: () => held("stepUpWebauthnVerify"),
    },
    billing: { subscription: async () => ({ status: "active", plan: "pro", credits: 100 }) },
    account: { access: async () => ({ metered: false }) },
    mailboxes: {
      list: async () => ({ items: rig.listed }),
      create: noted("mailboxes.create", {}),
      update: noted("mailboxes.update", {}),
      remove: async () => {
        if (rig.removeRefusals > 0) {
          rig.removeRefusals -= 1;
          throw new actual.ApiError(403, "step_up_required", "recent two-factor authentication required");
        }
        rig.calls.push("mailboxes.remove");
      },
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
  rig.removeRefusals = 1;
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

/** Let the held response land, the way it lands in a browser: after the press. */
async function landTheVerify(): Promise<void> {
  const settleIt = rig.settle!;
  expect(settleIt, "no verify was in flight to land").toBeTruthy();
  await act(async () => {
    settleIt({ user: { accountId: "acct", email: "person@example.test" } });
    await rig.inFlight;
    await new Promise((r) => setTimeout(r, 15));
  });
  await settle();
}

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test", displayName: null,
  status: "connected", lastSyncAt: "2026-09-15T11:00:00.000Z", createdAt: "2026-09-15T10:00:00.000Z",
  ...over,
} as MailboxDTO);

// ── 1. The mailbox pane: Cancel at the prompt ─────────────────────────────────────────────

describe("MailboxSection: a factor landing after Cancel removes no mailbox", () => {
  /** Walk a removal to the point where the factor is on the wire and nothing has been removed. */
  async function toTheFactorInFlight(): Promise<HTMLElement> {
    rig.listed = [dto()];
    const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
    const el = await render(h(MailboxSection));
    await click(byText(el, mb.remove!)!);
    await click(byText(el, mb.removeConfirm!)!);
    await waitFor(() => el.querySelector("#stepup-code") != null, "the step-up prompt");
    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    await waitFor(() => rig.settle != null, "the factor to be in flight");
    expect(rig.calls, "nothing is removed while the factor is still being checked")
      .not.toContain("mailboxes.remove");
    return el;
  }

  it("Cancel, then the factor lands — DELETE /mailboxes is never sent, and the pane says so", async () => {
    const el = await toTheFactorInFlight();
    await click(only(el, "button", dev.cancel!));
    await landTheVerify();

    expect(rig.calls, "the person cancelled before the check finished: the mailbox must stand")
      .not.toContain("mailboxes.remove");
    expect(el.textContent, "and the pane must SAY nothing changed")
      .toContain(mb.cancelledNothingChanged);
    expect(el.textContent, "Cancel returns to the confirmation it came from").toContain(mb.removeConfirm);
  }, 20000);

  /** THE POSITIVE CONTROL. This is the feature; a gate that refuses it is no fix. */
  it("an uncancelled step-up still removes the mailbox", async () => {
    const el = await toTheFactorInFlight();
    await landTheVerify();

    await waitFor(() => rig.calls.includes("mailboxes.remove"), "the removal");
    expect(el.textContent, "and it does not claim a cancellation that did not happen")
      .not.toContain(mb.cancelledNothingChanged);
  }, 20000);

  /** Cancel must stay pressable while the check runs — the erase fix's rule, at this pane too. */
  it("Cancel stays enabled while the factor is in flight", async () => {
    const el = await toTheFactorInFlight();
    const cancel = only(el, "button", dev.cancel!) as HTMLButtonElement;
    expect(cancel.disabled, "somebody who changes their mind must be able to").toBe(false);
    await click(cancel);
    expect(el.querySelector("#stepup-code"), "the prompt is down").toBeNull();
  }, 20000);
});

// ── 2. The desktop-link screen: a cancelled step-up mints nothing ───────────────────────────

describe("LinkDesktopScreen: a factor landing after Cancel mints no code", () => {
  async function toTheFactorInFlight(): Promise<HTMLElement> {
    const { LinkDesktopScreen } = await import("../app/(product)/link-desktop/LinkDesktopScreen.js");
    const el = await render(h(LinkDesktopScreen, {}));
    // The first mint is refused for a closed step-up window, which is what opens the prompt.
    await click(byText(el, link.mint!)!);
    await waitFor(() => el.querySelector("#stepup-code") != null, "the step-up prompt");
    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    await waitFor(() => rig.settle != null, "the factor to be in flight");
    return el;
  }

  it("Cancel, then the factor lands — no pairing code is minted, and the screen says so", async () => {
    const el = await toTheFactorInFlight();
    await click(only(el, "button", dev.cancel!));
    await landTheVerify();

    expect(rig.calls, "a cancelled step-up must mint nothing")
      .not.toContain("auth.desktopLink");
    expect(el.textContent, "and the screen must SAY no code was created")
      .toContain(link.cancelledNothingMinted);
  }, 20000);

  /** THE POSITIVE CONTROL. */
  it("an uncancelled step-up still mints the code the visitor came for", async () => {
    const el = await toTheFactorInFlight();
    await landTheVerify();

    await waitFor(() => rig.calls.includes("auth.desktopLink"), "the mint");
    expect(el.textContent, "and it does not claim a cancellation that did not happen")
      .not.toContain(link.cancelledNothingMinted);
  }, 20000);
});

// ── 3. The inline step-up: the unmount latch is gone ─────────────────────────────────────────

describe("StepUpPrompt: the gate is the generation, not the host dropping the pane", () => {
  /**
   * THE ARM THE ROW WAS FILED FOR. The prompt is driven with a host that does NOT unmount it, so
   * `alive.current` — the old gate — is true the whole way through: only the generation can
   * refuse the parked verb here. With the latch as the gate this arm calls `onVerified`.
   */
  it("Cancel, then the factor lands WHILE THE PROMPT IS STILL MOUNTED — the parked verb does not run", async () => {
    const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
    const seen: string[] = [];
    const el = await render(h(StepUpPrompt, {
      onVerified: () => { seen.push("verified"); },
      onCancel: () => { seen.push("cancelled"); },      // the host keeps it mounted on purpose
      onDiscarded: () => { seen.push("discarded"); },
    }));

    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    await waitFor(() => rig.settle != null, "the step-up to be in flight");

    await click(byText(el, dev.cancel!)!);
    await landTheVerify();

    expect(seen, "a factor landing after Cancel must not run the verb its host parked")
      .not.toContain("verified");
    expect(seen, "and the discard is reported, never swallowed").toContain("discarded");
  }, 20000);

  /** THE POSITIVE CONTROL. */
  it("an uncancelled step-up still verifies", async () => {
    const { StepUpPrompt } = await import("../app/(product)/mailbox/StepUpPrompt.js");
    const seen: string[] = [];
    const el = await render(h(StepUpPrompt, {
      onVerified: () => { seen.push("verified"); },
      onCancel: () => { seen.push("cancelled"); },
      onDiscarded: () => { seen.push("discarded"); },
    }));

    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    await waitFor(() => rig.settle != null, "the step-up to be in flight");
    await landTheVerify();

    expect(seen, "a step-up nobody cancelled must still verify").toContain("verified");
    expect(seen, "and it is not reported as discarded").not.toContain("discarded");
  }, 20000);

  /**
   * AND THROUGH THE REAL HOST, which DOES drop the prompt on Cancel: the sentence has to be the
   * devices pane's, because by the time the response lands there is no prompt left to read it
   * off. A device list that changed nothing looks exactly like one where the verb ran.
   */
  it("through DevicesSection: Cancel unmounts the prompt, the factor lands, and the PANE says nothing ran", async () => {
    const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
    const el = await render(h(DevicesSection));

    await waitFor(() => byText(el, dev.addAction!) != null, "the add-a-device verb");
    await click(byText(el, dev.addAction!)!);
    await waitFor(
      () => el.querySelector('[data-testid="step-up-prompt"]') != null,
      "the inline factor prompt",
    );

    await typeInto(el.querySelector("#stepup-code"), "123456");
    await submit(el.querySelector("#stepup-code")!.closest("form"));
    await waitFor(() => rig.settle != null, "the step-up to be in flight");
    rig.calls = [];

    await click(byText(el, dev.cancel!)!);
    expect(el.querySelector('[data-testid="step-up-prompt"]'), "the host dropped the prompt").toBeNull();
    await landTheVerify();

    expect(rig.calls, "the parked verb must not run after Cancel").not.toContain("pair.mintDevice");
    expect(el.textContent, "and the PANE says so, since the prompt is gone")
      .toContain(dev.stepUpCancelledNothingRan);
  }, 20000);
});

// ── The sentences are rendered, and translated ───────────────────────────────────────────────

describe("each surface's sentence", () => {
  /**
   * A state variable nobody paints and a comment explaining the discard are both a person who
   * cannot tell what their press did. Asked of the CATALOGUES here and of the DOM above.
   */
  it("is in both catalogues, translated, and de.json carries it as raw text", () => {
    const pairs: [string, string, string][] = [
      ["mailboxes", "cancelledNothingChanged", mb.cancelledNothingChanged!],
      ["linkDesktop", "cancelledNothingMinted", link.cancelledNothingMinted!],
      ["devices", "stepUpCancelledNothingRan", dev.stepUpCancelledNothingRan!],
    ];
    for (const [ns, key, enText] of pairs) {
      const deText = (de as unknown as Record<string, Record<string, string>>)[ns]![key];
      expect(enText, `en.json carries ${ns}.${key}`).toBeTruthy();
      expect(deText, `de.json carries ${ns}.${key}`).toBeTruthy();
      expect(deText, "the German is translated, not the English copied").not.toBe(enText);
      expect(deText, "raw text, never an escaped code point").not.toMatch(/\\u[0-9a-fA-F]{4}/);
    }
  });
});
