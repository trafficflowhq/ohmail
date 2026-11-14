/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { ApiError, type MailboxDTO, type SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ A DELAYED ANSWER MAY NOT RESTORE "ORGANIZING" AFTER THE PERSON STOPPED ═════════════════
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────
 *
 * The pane polls `GET /mailboxes` every ten seconds and applied every response under
 * `alive.current` alone — "is this pane still here", never "is this answer still current". So a
 * poll issued before "Hand the mailbox back" could land AFTER it: the Organizing description and
 * its control came back over a mailbox the person had just stood down, and stayed until the next
 * tick. The person is shown a false state about who organizes their mail and offered the control
 * for a state they have left.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 * The RENDERED description, never the pane's state: what a reader sees is the claim under test.
 *  1. poll A, stop, poll B, resolve A last  → the stopped sentence stands.
 *  2. the reverse order (B then A resolving first) also ends correct.
 *  3. an ordinary refresh still updates — the positive control, without which the rule could be
 *     satisfied by a pane that applies nothing at all.
 *  4. the stop's OWN answer outranks a poll issued before the press — the ruling's own clause.
 *     A poll that FAILS carries a sentence too (`listFailed` + the server's words), and a stale
 *     one landing on the queued answer replaces it with an outage nobody is having.
 *
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Measured, both arms, restored by copy and `cmp`:
 *  · `claim`'s comparison — `seq <= applied.current` → `false`, which IS the shape this pane
 *    shipped with — reddens 1, 2 and 4 on the rendered sentence; 3 stays green.
 *  · `publish`'s `applied.current = seq` deleted reddens 4 alone: the delayed poll then wins the
 *    window between the stop's answer and the refresh it makes.
 */

const copy = en.mailboxes as unknown as Record<string, string>;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;

const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

/** One held `GET /mailboxes`: the pane has asked, and nothing has answered yet. */
interface Held {
  resolve: (items: MailboxDTO[]) => void;
  reject: (err: Error) => void;
}

let held: Held[] = [];
let releaseCalls = 0;

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, accountId: "acc1" },
        scope: "full",
      }),
    },
    account: { access: async () => ({ metered: false, canAddMailbox: true, mailboxes: null }) },
    billing: { subscription: async () => ({ entitlements: null, subscription: healthy }) },
    mailboxes: {
      // Every read is HELD: the test decides the order answers come back in, which is the
      // whole subject. `oauthAvailability` is a mount-once read and answers at once.
      list: () => new Promise<{ items: MailboxDTO[] }>((res, rej) => {
        held.push({ resolve: (items) => res({ items }), reject: rej });
      }),
      oauthAvailability: async () => ({ available: false, device: false }),
      organizer: async () => ({ holders: [], unreadable: 0 }),
      release: async () => { releaseCalls += 1; return { outcome: "requested" }; },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

const organizing = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected",
  lastSyncAt: "2026-09-14T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "organizer",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  releaseRequestedAt: null,
  ...over,
} as MailboxDTO);

/** The same mailbox after the stop: the request stands, the pane says so. */
const stopping = (): MailboxDTO => organizing({ releaseRequestedAt: "2026-09-14T09:30:00.000Z" });

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

/** The banner's description, as somebody reads it. */
function organizerText(): string {
  return (host!.querySelector('[data-role="organizer"]')?.textContent ?? "").trim();
}

function buttonStarting(label: string): HTMLButtonElement | undefined {
  return [...host!.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function mount(): Promise<void> {
  await unmount();
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC",
      children: h(MailboxSection),
    }));
  });
  await settle();
  // The pane's opening read — answered so the row exists before anything races.
  expect(held.length, "the pane made no opening read").toBeGreaterThan(0);
  await act(async () => { held.shift()!.resolve([organizing()]); });
  await settle();
  expect(organizerText()).toContain(copy.stateOrganizingCloud);
}

beforeEach(() => {
  vi.useFakeTimers();
  held = [];
  releaseCalls = 0;
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
});

afterEach(async () => {
  await unmount();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** One poll tick — the pane's own ten-second timer. */
async function tick(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(10_000); });
  await settle();
}

async function pressStop(): Promise<void> {
  await click(buttonStarting(copy.stopOrganizingHandBack!));
  await click(buttonStarting(copy.stopOrganizingConfirm!));
}

describe("the pane applies the newest answer, never the last one to arrive", () => {
  it("a poll issued before the stop cannot restore Organizing when it lands after it", async () => {
    await mount();
    await tick();
    const pollA = held.shift();
    expect(pollA, "the tick issued no poll").toBeTruthy();

    // The stop: its own answer, then the refresh it makes — both newer than poll A.
    await pressStop();
    expect(releaseCalls, "the stop never reached the server").toBe(1);
    const afterStop = held.shift();
    expect(afterStop, "the stop made no refresh").toBeTruthy();
    await act(async () => { afterStop!.resolve([stopping()]); });
    await settle();
    expect(organizerText()).toContain(copy.stopOrganizingPending);

    // …and NOW the delayed one lands, carrying the mailbox as it was before the press.
    await act(async () => { pollA!.resolve([organizing()]); });
    await settle();
    expect(organizerText(), "a delayed poll restored Organizing").toContain(copy.stopOrganizingPending);
    expect(organizerText()).not.toContain(copy.stateOrganizingCloud);
  });

  it("the stop's own answer retires the delayed poll before its refresh has answered", async () => {
    await mount();
    await tick();
    const pollA = held.shift()!;

    // The stop answers; the refresh it makes is still in flight — this is the window the
    // release's own sequence exists for, and the only one `refresh` cannot close by itself.
    await pressStop();
    const afterStop = held.shift();
    expect(afterStop, "the stop made no refresh").toBeTruthy();
    expect(host!.textContent, "the stop said nothing").toContain(copy.stopOrganizingQueuedCloud);

    // An `ApiError`: `messageOf` renders the SERVER'S sentence for one and a generic line for
    // anything else, so a plain `Error` would have made this assertion about nothing.
    await act(async () => { pollA.reject(new ApiError(503, "unavailable", "STALE POLL FAILED")); });
    await settle();
    expect(host!.textContent, "the queued sentence was overwritten").toContain(copy.stopOrganizingQueuedCloud);
    expect(host!.textContent, "a failed poll from before the press wrote its outage").not.toContain("STALE POLL FAILED");

    // …and the refresh, when it lands, is still the newest word.
    await act(async () => { afterStop!.resolve([stopping()]); });
    await settle();
    expect(organizerText()).toContain(copy.stopOrganizingPending);
  });

  it("B then A: the older answer loses whichever way round they resolve", async () => {
    await mount();
    await tick();
    const pollA = held.shift()!;
    await tick();
    const pollB = held.shift()!;

    await act(async () => { pollB.resolve([stopping()]); });
    await settle();
    await act(async () => { pollA.resolve([organizing()]); });
    await settle();
    expect(organizerText(), "the older poll won").toContain(copy.stopOrganizingPending);
  });

  it("an ordinary refresh still updates the row (the positive control)", async () => {
    await mount();
    await tick();
    await act(async () => { held.shift()!.resolve([stopping()]); });
    await settle();
    expect(organizerText()).toContain(copy.stopOrganizingPending);
  });
});
