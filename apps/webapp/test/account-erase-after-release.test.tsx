/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * A FAILED ERASE SAYS WHAT THE RELEASE ALREADY DID. `DELETE /account` stops the subscription before
 * it erases, so an erasure that then fails has cancelled the subscription and removed nothing else.
 * The server's 503 or 500 carries `details.subscription`; the pane names it in en and de, keeps a
 * `cancelled` from the first press, and the later receipt says the subscription was cancelled even
 * when the retry's own release had nothing left to cancel.
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer =
  | { kind: "fail"; status: number; code: string; subscription?: string; coded?: boolean }
  | { kind: "ok"; subscription: "none" | "cancelled" | "cancel_failed" };

/** The scripted answers, one per press, shared with the hoisted module factory. */
const rig = vi.hoisted(() => ({ answers: [] as unknown[], presses: 0 }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));

vi.mock("../app/sign-out", async (original) => ({
  ...await original<typeof import("../app/sign-out")>(),
  forgetThisBrowser: async () => ({ remaining: [], inventoryComplete: true }),
  signOut: async () => ({ cleared: true, inventoryComplete: true, serverRefused: null, remaining: [] }),
}));

vi.mock("../app/api-client", () => {
  // A scripted answer is our server's envelope unless it says `coded: false` (a platform's own 5xx).
  class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown,
      readonly wire: { coded: boolean } = { coded: true }) {
      super(message);
      this.name = "ApiError";
    }
  }
  return {
    ApiError,
    apiConfigured: () => true,
    accessFeedFor: () => null,
    onAccessFeed: () => () => {},
    webauthnAvailable: () => false,
    assertPasskey: async () => ({ id: "credential" }),
    codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    auth: {
      session: async () => ({
        user: { accountId: "acct-under-test", email: "person@example.test", twofaEnrolled: { webauthn: false, totp: true } },
        scope: "full",
      }),
    },
    account: {
      access: async () => ({ metered: true, access: "open" }),
      erase: async () => {
        const a = rig.answers[rig.presses] as Answer | undefined;
        rig.presses += 1;
        if (!a) throw new Error("no scripted answer for this press");
        if (a.kind === "ok") return { erased: true, retained: "billing records", subscription: a.subscription };
        throw new ApiError(a.status, a.code, "the account could not be deleted",
          a.subscription === undefined ? undefined : { subscription: a.subscription }, { coded: a.coded ?? true });
      },
    },
  };
});

let roots: Root[] = [];
beforeEach(() => {
  rig.answers = [];
  rig.presses = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
}

async function mount(locale: "en" | "de"): Promise<HTMLElement> {
  const { AccountSection } = await import("../app/(product)/mailbox/AccountSection.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC",
      now: new Date("2026-10-03T09:00:00.000Z"), children: h(AccountSection),
    }));
  });
  await waitFor(() => container.querySelector("#acct-typed") != null, "the facts step");
  return container;
}

/** Type the address and press: one `DELETE /account`, on a fresh window. */
async function press(container: HTMLElement): Promise<void> {
  const before = rig.presses;
  const input = container.querySelector<HTMLInputElement>("#acct-typed")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "person@example.test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form.acct-confirm")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await waitFor(() => rig.presses === before + 1, "the erase to be sent");
  await waitFor(() => container.querySelector("#acct-typed") != null
    || container.textContent!.includes(en.account.doneTitle) || container.textContent!.includes(de.account.doneTitle),
  "the press to settle");
}

const text = (c: HTMLElement): string => c.textContent ?? "";

describe("a failed erase names what the release did", () => {
  for (const locale of ["en", "de"] as const) {
    const m = locale === "en" ? en : de;
    it(`${locale}: a 503 after the subscription was cancelled says so, and the retry's receipt keeps it`, async () => {
      rig.answers = [
        { kind: "fail", status: 503, code: "erasure_contended", subscription: "cancelled" },
        { kind: "ok", subscription: "none" },
      ];
      const c = await mount(locale);
      await press(c);
      expect(text(c)).toContain(m.account.eraseRefusedSubCancelled);
      expect(text(c)).not.toContain(m.account.eraseRefused);
      await press(c);
      await waitFor(() => text(c).includes(m.account.doneTitle), "the receipt");
      expect(text(c), "the retry's release answered none; the first press cancelled").toContain(m.account.doneSubCancelled);
      expect(text(c)).not.toContain(m.account.doneSubFailed);
    });
  }

  it("a 500 with nothing released keeps today's sentence", async () => {
    rig.answers = [{ kind: "fail", status: 500, code: "erasure_failed", subscription: "none" }];
    const c = await mount("en");
    await press(c);
    expect(text(c)).toContain(en.account.eraseRefused);
    expect(text(c)).not.toContain(en.account.eraseRefusedSubCancelled);
  });

  it("a failure whose release also failed says both", async () => {
    rig.answers = [{ kind: "fail", status: 500, code: "erasure_failed", subscription: "cancel_failed" }];
    const c = await mount("en");
    await press(c);
    expect(text(c)).toContain(en.account.eraseRefusedSubFailed);
  });

  it("a second failure answering none after a first cancel still says the subscription was cancelled", async () => {
    rig.answers = [
      { kind: "fail", status: 503, code: "erasure_contended", subscription: "cancelled" },
      { kind: "fail", status: 503, code: "erasure_contended", subscription: "none" },
    ];
    const c = await mount("en");
    await press(c);
    await press(c);
    expect(rig.presses).toBe(2);
    expect(text(c)).toContain(en.account.eraseRefusedSubCancelled);
    expect(text(c)).not.toContain(en.account.eraseRefused);
  });

  for (const locale of ["en", "de"] as const) {
    const m = locale === "en" ? en : de;
    it(`${locale}: an outcome the server could not confirm is said so, never "not deleted", and keeps the cancel`, async () => {
      rig.answers = [
        { kind: "fail", status: 503, code: "erasure_unconfirmed", subscription: "cancelled" },
        { kind: "ok", subscription: "none" },
      ];
      const c = await mount(locale);
      await press(c);
      expect(text(c), "the unconfirmed sentence carries the cancel the 503 carried").toContain(m.account.eraseUnconfirmedSubCancelled);
      for (const notDeleted of [m.account.eraseRefused, m.account.eraseRefusedSubCancelled, m.account.eraseRefusedSubFailed]) {
        expect(text(c)).not.toContain(notDeleted);
      }
      await press(c);
      await waitFor(() => text(c).includes(m.account.doneTitle), "the receipt");
      expect(text(c)).toContain(m.account.doneSubCancelled);
    });
  }

  for (const locale of ["en", "de"] as const) {
    const m = locale === "en" ? en : de;
    it(`${locale}: a 5xx no envelope of ours carries (the function cut mid-erasure) is unconfirmed, never "not deleted"`, async () => {
      rig.answers = [{ kind: "fail", status: 504, code: "internal", coded: false }];
      const c = await mount(locale);
      await press(c);
      expect(text(c)).toContain(m.account.eraseUnconfirmed);
      for (const notDeleted of [m.account.eraseRefused, m.account.eraseRefusedSubCancelled, m.account.eraseRefusedSubFailed]) {
        expect(text(c)).not.toContain(notDeleted);
      }
    });
  }

  it("a platform 5xx after a first press that cancelled says unconfirmed and keeps the cancel", async () => {
    rig.answers = [
      { kind: "fail", status: 503, code: "erasure_contended", subscription: "cancelled" },
      { kind: "fail", status: 502, code: "internal", coded: false },
    ];
    const c = await mount("en");
    await press(c);
    await press(c);
    expect(rig.presses).toBe(2);
    expect(text(c)).toContain(en.account.eraseUnconfirmedSubCancelled);
    expect(text(c)).not.toContain(en.account.eraseRefusedSubCancelled);
  });

  it("an unconfirmed outcome whose cancellation failed says the subscription may still be active", async () => {
    rig.answers = [{ kind: "fail", status: 503, code: "erasure_unconfirmed", subscription: "cancel_failed" }];
    const c = await mount("en");
    await press(c);
    expect(text(c)).toContain(en.account.eraseUnconfirmedSubFailed);
    expect(en.account.eraseUnconfirmedSubFailed).toMatch(/may still be active/);
    expect(de.account.eraseUnconfirmedSubFailed).toMatch(/kann noch laufen/);
    expect(text(c)).not.toContain(en.account.eraseRefusedSubFailed);
  });

  it("CONTROL: our own 5xx envelope with nothing released keeps today's sentence", async () => {
    rig.answers = [{ kind: "fail", status: 502, code: "internal", subscription: "none" }];
    const c = await mount("en");
    await press(c);
    expect(text(c)).toContain(en.account.eraseRefused);
  });

  it("the failed-cancellation sentence claims only what a release with no answer allows", () => {
    // `cancel_failed` covers a release that got no answer: the subscription's state is not known.
    expect(en.account.eraseRefusedSubFailed).toMatch(/may still be active/);
    expect(en.account.eraseRefusedSubFailed).not.toMatch(/could not be cancelled/);
    expect(de.account.eraseRefusedSubFailed).toMatch(/kann noch laufen/);
    expect(de.account.eraseRefusedSubFailed).not.toMatch(/konnte auch nicht gekündigt/);
  });

  it("CONTROL: an answer with no details (an older server) keeps today's sentence", async () => {
    rig.answers = [{ kind: "fail", status: 500, code: "internal" }];
    const c = await mount("en");
    await press(c);
    expect(text(c)).toContain(en.account.eraseRefused);
  });
});
