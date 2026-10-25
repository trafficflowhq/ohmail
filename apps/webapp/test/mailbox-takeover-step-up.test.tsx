/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "../app/shell/mail-state";

/**
 * ═══ A STEP-UP REFUSAL ON THE TAKE-OVER OPENS THE PROMPT, IT DOES NOT END THE PRESS ════════
 *
 * `POST /mailboxes/:id/organize` is step-up gated, so a press on a closed five-minute window
 * answers 403. The pane used to print the refusal and stop, on the one row whose ONLY remedy is
 * that press: a mailbox the organizer lease stood down offers a take-over and nothing else.
 *
 * The gating does not change and the window is not widened. What is pinned is where a refusal
 * LEAVES somebody: the same `StepUpPrompt` the create, the edit and the removal park behind, with
 * the press held across it and made again the instant a factor verifies — on the session the
 * browser holds, never a sign-in.
 *
 * ── HOW TO WATCH THESE FAIL ────────────────────────────────────────────────────────────────
 *
 *  · drop the `park` in `pressTakeover` → the prompt never opens and the first case goes red;
 *  · re-run nothing from the prompt's `onVerified` → the third case goes red with `organize`
 *    called once;
 *  · admit every refusal to the prompt instead of the step-up one → the second case goes red.
 */

const copy = en.mailboxes as unknown as Record<string, string>;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;

const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];
/** Every id `POST /mailboxes/:id/organize` was asked for, in order. */
let mockOrganizeCalls: string[] = [];
/** What that route answers on the NEXT call — shifted, so a retry can be told from the first try. */
let mockOrganizeAnswers: Array<() => { outcome: string }> = [];
let mockLoginCalls = 0;
let mockStepUpCalls = 0;
/** The self-host build's arm: "Take over on this server…" instead of "… on Cloud…". */
let mockSelfHost = false;
/** Every removal asked for, as `remove:<id>` or `erase:<id>`, and what the next one answers. */
let mockRemoveCalls: string[] = [];
let mockRemoveAnswers: Array<() => unknown> = [];

vi.mock("../app/hello", async () => {
  const actual = await vi.importActual<typeof import("../app/hello")>("../app/hello");
  return { ...actual, get SELF_HOST_BUILD() { return mockSelfHost; } };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: {
          email: "person@example.test", emailVerified: true, accountId: "acc1",
          twofaEnrolled: { webauthn: false, totp: true },
        },
        scope: "full",
      }),
      login: async () => {
        mockLoginCalls += 1;
        return { status: "twofa_required", loginToken: "lt1", methods: ["totp"] };
      },
      stepUpTotp: async () => { mockStepUpCalls += 1; return { ok: true }; },
    },
    billing: { subscription: async () => ({ entitlements: null, subscription: healthy }) },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      organizer: async () => ({ holders: [], unreadable: 0 }),
      organize: async (id: string) => {
        mockOrganizeCalls.push(id);
        const next = mockOrganizeAnswers.shift();
        if (!next) return { outcome: "authorized" };
        return next();
      },
      remove: async (id: string) => {
        mockRemoveCalls.push(`remove:${id}`);
        const next = mockRemoveAnswers.shift();
        return next ? next() : undefined;
      },
      erase: async (id: string) => {
        mockRemoveCalls.push(`erase:${id}`);
        const next = mockRemoveAnswers.shift();
        if (next) return next();
        return { mailboxId: id, erasing: false, messages: 0, drafts: 0, draftsUnanchored: 0 };
      },
    },
  };
});

const stepUp = (): never => {
  throw new ApiError(403, "step_up_required", "Confirm it is you before making this change.");
};
const taken = (): never => {
  throw new ApiError(409, "mailbox_exists", "This mailbox is already connected to your account.");
};

/**
 * THE ROW MIGRATION 0083 DELIBERATELY LEFT BEHIND: `disabled` with the lease's own reason, which
 * `readerStandDown`'s legacy arm reads and this pane renders with the take-over on it.
 */
const legacyStandDown = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "disabled", disabledReason: "organized_elsewhere:local",
  lastSyncAt: "2026-09-04T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "reader",
  organizedBy: { kind: "local", name: "a laptop", since: "2026-09-01T08:00:00.000Z" },
  organizerState: "held",
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  ...over,
} as MailboxDTO);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function mount(...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, children: h(MailboxSection),
    }));
  });
  await settle();
  return host;
}

function button(el: HTMLElement, text: string): HTMLElement {
  const found = [...el.querySelectorAll("button, a")]
    .filter((n) => (n.textContent ?? "").trim() === text);
  // A COUNT-REFUSING MATCH: two candidates mean the press is ambiguous and neither is pressed.
  expect(found.length, `expected exactly one control reading "${text}", found ${found.length}`).toBe(1);
  return found[0] as HTMLElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

/** Press the row's take-over through the two steps the stand-down branch draws. */
async function pressTakeover(el: HTMLElement): Promise<void> {
  await click(button(el, copy.organizerCheck!));
  await click(button(el, copy.organizerConfirm!));
}

beforeEach(() => {
  mockListed = [];
  mockOrganizeCalls = [];
  mockOrganizeAnswers = [];
  mockLoginCalls = 0;
  mockStepUpCalls = 0;
  mockSelfHost = false;
  mockRemoveCalls = [];
  mockRemoveAnswers = [];
});
afterEach(async () => { await unmount(); });

const promptOf = (el: HTMLElement): Element | null => el.querySelector('[data-testid="step-up-prompt"]');

describe("the take-over's step-up refusal", () => {
  it("opens the same step-up prompt the connect, the edit and the removal park behind", async () => {
    mockOrganizeAnswers = [stepUp];
    const el = await mount(legacyStandDown());
    await pressTakeover(el);

    expect(mockOrganizeCalls, "the press never reached the route").toEqual(["mb1"]);
    expect(promptOf(el), "a step-up refusal left the person on the list with no way forward").not.toBeNull();
    expect(el.querySelector('input[type="password"]'), "the take-over asked for a password").toBeNull();
    expect(el.textContent, "the prompt never said the factor is for the take-over")
      .toContain(copy.factorBodyTakeover ?? "factorBodyTakeover");
  });

  it("does NOT open it for a refusal that a second factor cannot fix", async () => {
    mockOrganizeAnswers = [taken];
    const el = await mount(legacyStandDown());
    await pressTakeover(el);

    const said = el.textContent ?? "";
    expect(promptOf(el), "an unrelated refusal was answered with a second-factor prompt").toBeNull();
    expect(said, "the refusal's own sentence never reached the screen")
      .toContain("already connected");
  });

  it("holds the ask across the prompt and presses it again when the factor verifies", async () => {
    mockOrganizeAnswers = [stepUp];
    const el = await mount(legacyStandDown());
    await pressTakeover(el);

    const code = el.querySelector("#stepup-code");
    expect(code, "the prompt did not render a code field").not.toBeNull();
    await type(code as HTMLInputElement, "123456");
    await submit((code as HTMLElement).closest("form") as HTMLFormElement);

    expect(mockStepUpCalls, "the factor was never verified").toBe(1);
    expect(mockLoginCalls, "the take-over signed in again — one more web session").toBe(0);
    // THE WHOLE POINT: the ask survived the prompt and was made again, for the SAME mailbox.
    expect(mockOrganizeCalls, "the verified factor did not re-press the take-over")
      .toEqual(["mb1", "mb1"]);
    // And the pane lands back on the list rather than sitting on the prompt.
    expect(promptOf(el), "the prompt did not close").toBeNull();
    expect(el.textContent, "the retried take-over did not say it is under way").toContain(copy.organizerQueued);
  });

  it("Cancel on the prompt presses nothing and says nothing changed, until the next press", async () => {
    mockOrganizeAnswers = [stepUp];
    const el = await mount(legacyStandDown());
    await pressTakeover(el);
    await click(button(el, en.devices.cancel));

    expect(mockOrganizeCalls, "Cancel re-pressed the take-over").toEqual(["mb1"]);
    expect(promptOf(el), "the prompt stayed up after Cancel").toBeNull();
    expect(el.textContent, "the row looks as before, so the pane must say nothing changed")
      .toContain(copy.cancelledNothingChanged);

    await pressTakeover(el);
    expect(el.textContent).toContain(copy.organizerQueued);
    expect(el.textContent, "a later take-over that worked still says nothing changed")
      .not.toContain(copy.cancelledNothingChanged);
  });
});

/**
 * ═══ THE CARD: A SELF-HOST MAILBOX THE DESKTOP HANDED BACK ═══════════════════════════════════
 *
 * The desktop organized the server's mailbox and handed it back, so the row is a `connected` reader with no holder:
 * "The install that organized this mailbox has stopped, and nothing organizes it now", with "Take over on this
 * server…". Take over answered 403 step_up_required and the card itself reset to that same button while the code
 * prompt opened under the list with no line naming the take-over, so the person saw the press do nothing. The prompt
 * now opens IN the card that was pressed, says what the code is for, and the verified code takes over once.
 *
 * HOW TO WATCH IT FAIL: render the take-over's prompt only in the pane's own `stage === "stepup"` block → the first
 * case goes red (the prompt is not in the card, the card still offers "Take over on this server…").
 */
const handedBack = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected", disabledReason: null,
  lastSyncAt: "2026-10-25T04:10:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "reader",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  organizedByThisInstall: false,
  ...over,
} as MailboxDTO);

/** The row that draws the stand-down sentence — the card the tester pressed. */
function cardOf(el: HTMLElement): HTMLElement {
  const rows = [...el.querySelectorAll(".mbx-row")]
    .filter((r) => (r.textContent ?? "").includes(copy.standDownLapsed!));
  expect(rows.length, "the handed-back card is not on screen").toBe(1);
  return rows[0] as HTMLElement;
}

async function pressServerTakeover(el: HTMLElement): Promise<void> {
  await click(button(el, copy.organizerCheckServer!));
  await click(button(el, copy.organizerConfirm!));
}

describe("the handed-back card: Take over on this server after the desktop handed the mailbox back", () => {
  it("a step-up refusal opens the code prompt IN the card, naming the take-over", async () => {
    mockSelfHost = true;
    mockOrganizeAnswers = [stepUp];
    const el = await mount(handedBack());
    expect(cardOf(el).textContent, "not the tester's card").toContain(copy.standDownHowLapsedServer);
    await pressServerTakeover(el);

    expect(mockOrganizeCalls).toEqual(["mb1"]);
    const card = cardOf(el);
    expect(promptOf(card), "the code prompt is not in the card that was pressed").not.toBeNull();
    expect(card.textContent, "the card never said the code is for the take-over")
      .toContain(copy.factorBodyTakeover);
    expect(
      [...card.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === copy.organizerCheckServer),
      "the card still offers the press that was just refused, as if nothing happened",
    ).toBe(false);
    expect(el.querySelectorAll('[data-testid="step-up-prompt"]').length, "two prompts").toBe(1);
  });

  it("the verified code takes the mailbox over once, on this server", async () => {
    mockSelfHost = true;
    mockOrganizeAnswers = [stepUp];
    const el = await mount(handedBack());
    await pressServerTakeover(el);
    const code = cardOf(el).querySelector("#stepup-code") as HTMLInputElement | null;
    expect(code, "no code field in the card").not.toBeNull();
    await type(code!, "123456");
    await submit(code!.closest("form") as HTMLFormElement);

    expect(mockStepUpCalls).toBe(1);
    expect(mockLoginCalls, "the take-over signed in again").toBe(0);
    expect(mockOrganizeCalls, "the verified code did not take over once more").toEqual(["mb1", "mb1"]);
    expect(promptOf(el)).toBeNull();
    expect(el.textContent).toContain(copy.organizerQueuedServer);
  });

  it("Cancel says nothing changed and leaves the card as it was", async () => {
    mockSelfHost = true;
    mockOrganizeAnswers = [stepUp];
    const el = await mount(handedBack());
    await pressServerTakeover(el);
    await click(button(el, en.devices.cancel));

    expect(mockOrganizeCalls, "Cancel took over").toEqual(["mb1"]);
    expect(promptOf(el)).toBeNull();
    expect(el.textContent).toContain(copy.cancelledNothingChanged);
    expect(cardOf(el).textContent).toContain(copy.organizerCheckServer);
  });
});

/**
 * ═══ ANOTHER MAILBOX'S REMOVAL, REFUSED WHILE THE TAKE-OVER'S PROMPT WAS OPEN ════════════════
 *
 * A's take-over asks for the code in A's card; the person leaves it and presses Remove on B, and the removal is
 * refused for a code too. That prompt is the REMOVAL's: it says what the code is for in the removal's words, it
 * does not open in A's card under the take-over's line, and A's card offers its take-over again — the code
 * entered there removes B, which the take-over's line would have hidden.
 *
 * HOW TO WATCH IT FAIL: pick the card and the line from the take-over state alone, without asking which write is
 * parked → both cases go red (the prompt opens in A's card, reading "This mailbox is taken over…").
 */
const healthyOther = (): MailboxDTO => ({
  id: "mb2", provider: "imap", address: "other@example.test",
  displayName: null, status: "connected", disabledReason: null,
  lastSyncAt: "2026-10-25T04:10:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: "held",
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  organizedByThisInstall: false,
} as MailboxDTO);

function rowOf(el: HTMLElement, address: string): HTMLElement {
  const rows = [...el.querySelectorAll(".mbx-row")].filter((r) => (r.textContent ?? "").includes(address));
  expect(rows.length, `the card for ${address} is not on screen`).toBe(1);
  return rows[0] as HTMLElement;
}

async function takeoverAskedThenRemoveOther(el: HTMLElement, erase: boolean): Promise<void> {
  await pressServerTakeover(el);
  expect(promptOf(cardOf(el)), "the take-over's prompt did not open in its card").not.toBeNull();
  await click(button(rowOf(el, "other@example.test"), copy.remove!));
  if (erase) {
    await click(el.querySelector("#mb-remove-erase") as HTMLElement);
    await type(el.querySelector("#mb-erase-confirm") as HTMLInputElement, "other@example.test");
  }
  await click(button(el, erase ? copy.removeEraseConfirm! : copy.removeConfirm!));
}

describe("a removal refused for a code while a take-over's prompt is open", () => {
  it("asks in the removal's own words, not in the take-over's card, and the code removes that mailbox", async () => {
    mockSelfHost = true;
    mockOrganizeAnswers = [stepUp];
    mockRemoveAnswers = [stepUp];
    const el = await mount(handedBack(), healthyOther());
    await takeoverAskedThenRemoveOther(el, false);

    expect(mockRemoveCalls).toEqual(["remove:mb2"]);
    expect(el.querySelectorAll('[data-testid="step-up-prompt"]').length, "no single prompt").toBe(1);
    expect(promptOf(cardOf(el)), "the removal's prompt opened inside the take-over's card").toBeNull();
    const said = el.textContent ?? "";
    expect(said, "the prompt never said the code is for the removal").toContain(copy.factorBodyRemove);
    expect(said, "the removal's prompt read as the take-over").not.toContain(copy.factorBodyTakeover);
    expect(
      [...cardOf(el).querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === copy.organizerCheckServer),
      "the take-over's card still holds a press the person left",
    ).toBe(true);

    const code = el.querySelector("#stepup-code") as HTMLInputElement | null;
    expect(code).not.toBeNull();
    await type(code!, "123456");
    await submit(code!.closest("form") as HTMLFormElement);
    expect(mockRemoveCalls, "the verified code did not remove the mailbox it was asked for").toEqual(["remove:mb2", "remove:mb2"]);
    expect(mockOrganizeCalls, "the verified code took the other mailbox over").toEqual(["mb1"]);
  });

  it("an erase asks in the erase's words", async () => {
    mockSelfHost = true;
    mockOrganizeAnswers = [stepUp];
    mockRemoveAnswers = [stepUp];
    const el = await mount(handedBack(), healthyOther());
    await takeoverAskedThenRemoveOther(el, true);

    expect(mockRemoveCalls).toEqual(["erase:mb2"]);
    expect(promptOf(cardOf(el)), "the erase's prompt opened inside the take-over's card").toBeNull();
    expect(el.textContent).toContain(copy.factorBodyErase);
    expect(el.textContent).not.toContain(copy.factorBodyTakeover);
  });
});
