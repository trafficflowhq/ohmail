/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * "HOW MANY MAILS" ON THE MAILBOX ROW, and the two ways it can be a lie.
 *
 * Settings → Mailboxes said everything about a mailbox except how much mail is in it. The
 * server now answers that, but only when asked (`GET /mailboxes?counts=1`), and the asking is
 * what this file is about — because the pane has TWO readers of the same route with opposite
 * requirements:
 *
 *   · the mount, which wants the number; and
 *   · a 10-second poll, which wants the sync state and must not pay for an aggregate over the
 *     account's whole message history six times a minute.
 *
 * That split creates the failure mode this file exists to hold down. A countless response omits
 * `messageCount` entirely, so a poll that REPLACED the list would make the number appear on
 * open, survive one tick, and disappear for the rest of the visit — which reads as a bug in the
 * count rather than in the polling. And the inverse is worse: rendering an absent field as `0`
 * would put "0 messages" on a full mailbox every ten seconds.
 *
 * ── THE DEPENDENCY IS INJECTED, AND BOTH BRANCHES ARE DRIVEN ────────────────────────────
 *
 * `mailboxes.list` is mocked, records the options it was handed, and answers from a fixture the
 * test rewrites between reads — so "the pane asked for counts" and "the pane rendered what came
 * back" are separate assertions rather than one round trip nobody can see inside.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, blockedReason: null, mailboxCount: 1, settled: true,
} as unknown as MailState;

/** What the next `list()` answers with, and what every `list()` was asked for. */
const served: { items: MailboxDTO[] } = { items: [] };
const asked: Array<{ counts?: boolean }> = [];

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
  messageOf: (e: unknown) => String(e),
  auth: {
    session: async () => ({
      user: { email: "owner@example.test", emailVerified: true }, scope: "full",
    }),
  },
  billing: {
    subscription: async () => ({
      subscription: {
        plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
        currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
      },
      balance: 0,
      plans: {},
      entitlements: {
        mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true, reason: "active",
      },
    }),
  },
  mailboxes: {
    list: async (opts: { counts?: boolean } = {}) => {
      asked.push(opts);
      return { items: served.items.map((m) => ({ ...m })) };
    },
    create: async () => served.items[0]!,
    resync: async () => undefined,
    oauthAvailability: async () => ({ available: false }),
  },
}));

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

const mailbox = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "imap", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: "2026-08-06T10:00:00.000Z",
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

/** Mount the real pane over whatever `served` holds. */
async function mount(): Promise<void> {
  await unmount();
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
  });
  await settle();
}

/** Let the mount's effects and their microtasks land. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

const sub = (): string => host?.querySelector(".mbx-sub")?.textContent ?? "";

beforeEach(() => { asked.length = 0; served.items = []; });
afterEach(async () => { await unmount(); vi.useRealTimers(); });

describe("Settings → Mailboxes says how much mail is in each mailbox", () => {
  it("THE FEATURE: the row carries the count, grouped and localized", async () => {
    served.items = [mailbox({ messageCount: 1268 })];
    await mount();
    /* The app's quiet meta idiom — one dot-separated sub-line, not a new element competing with
       the status. And the number is FORMATTED: `#` inside an ICU plural runs through the
       locale's number format, so four digits arrive with a separator rather than as `1268`. */
    expect(sub()).toContain("1,268" + " messages");
  });

  it("ONE message is not `1 messages` — the plural category is the catalogue's, not a suffix", async () => {
    served.items = [mailbox({ messageCount: 1 })];
    await mount();
    expect(sub()).toContain("1 message");
    expect(sub()).not.toContain("1 messages");
  });

  it("`0` IS AN ANSWER and it is rendered — an empty mailbox says so", async () => {
    /* The other half of the absent/zero distinction. A mailbox mid-first-import genuinely holds
       nothing yet, and the honest row says "0 messages" rather than falling silent — silence is
       reserved for "nobody asked". */
    served.items = [mailbox({ messageCount: 0 })];
    await mount();
    expect(sub()).toContain("0 messages");
  });

  it("REGRESSION: an ABSENT count renders NOTHING — never `0 messages` about a full mailbox", async () => {
    /**
     * The injected dependency's other branch: a server that predates this field, a build talking
     * to an older API, or simply a response to a request that did not ask. All three arrive as
     * an absent `messageCount`, and all three mean "we do not know" — which is not zero.
     *
     * The read has to be `typeof === "number"`. A `?? 0`, or a truthiness check, turns the one
     * case the optionality exists for into a confident false statement on somebody's screen.
     */
    served.items = [mailbox()];
    await mount();
    expect(sub()).not.toMatch(/message/i);
    expect(host!.textContent ?? "").not.toMatch(/\d+\s+messages?\b/);
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════
     WHO ASKS, AND WHO MUST NOT
     ══════════════════════════════════════════════════════════════════════════════════════ */

  it("the pane asks for counts ONCE, on open", async () => {
    served.items = [mailbox({ messageCount: 42 })];
    await mount();
    expect(asked.filter((o) => o.counts === true)).toHaveLength(1);
  });

  it("REGRESSION: the 10-second poll does NOT ask, and does not erase the number either", async () => {
    /**
     * Both halves of the same decision, because either one alone is a defect:
     *
     *  · the poll asking would charge an aggregate over the account's whole `messages` table
     *    six times a minute for a number that changes by single digits an hour; and
     *  · the poll REPLACING the list would drop the field the mount fetched, so the count would
     *    appear, last exactly one tick, and vanish — the shape of a bug in the count.
     */
    vi.useFakeTimers();
    served.items = [mailbox({ messageCount: 1268 })];
    await mount();
    expect(sub()).toContain("1,268" + " messages");

    // What a poll actually receives: the same mailbox, no count.
    served.items = [mailbox({ lastSyncAt: "2026-08-06T10:00:10.000Z" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    await settle();

    expect(asked.length, "the poll never ran").toBeGreaterThan(1);
    expect(
      asked.slice(1).filter((o) => o.counts === true),
      "a poll asked for the aggregate",
    ).toEqual([]);
    expect(
      sub(),
      "the poll replaced the list and took the count with it",
    ).toContain("1,268" + " messages");
  });

  it("a mailbox that leaves the list does not lend its count to another row", async () => {
    /* The merge is keyed off the INCOMING rows, so a carried-forward number can only ever land
       on the row it came from. Asserted because a merge written the other way round — iterate
       the previous list — resurrects deleted rows. */
    vi.useFakeTimers();
    served.items = [mailbox({ id: "gone", messageCount: 999 })];
    await mount();
    expect(sub()).toContain("999" + " messages");

    served.items = [mailbox({ id: "fresh", address: "other@example.test" })];
    await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
    await settle();

    expect(host!.textContent ?? "").not.toContain("999");
    expect(host!.textContent ?? "").toContain("other@example.test");
  });
});
