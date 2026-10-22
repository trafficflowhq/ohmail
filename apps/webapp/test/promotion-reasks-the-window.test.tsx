/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailboxFacts } from "../app/shell/mail-state";
import {
  ISO, answerConsentWith, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * A PROMOTION RE-ASKS THE WINDOW (R20-02). A mailbox with no consent is a reader with no mirrored
 * document, so `GET /consent` answers its window `unread` (the folder whole). The Agree press and
 * the promotion move the role on `GET /mailboxes` but ring no `/sync` row a never-documented
 * mailbox can carry, so the device kept the whole-folder window: a sender quiet for 120 days, whom
 * the server retires at 90, presented as waiting. Driven through the shipped shell: the facts flip
 * reader -> organizer, the shell asks `GET /consent` once more, and the Screener stops listing the
 * stranger, who presents under History.
 */

const OWN_90 = { mb_1: { baselineAt: ISO, dormancyDays: 90, scope: "window", source: "own", holder: null, asOf: null } };
const UNREAD = { mb_1: { baselineAt: null, dormancyDays: 60, scope: "all_time", source: "unread", holder: null, asOf: null } };
const BOTH_UNREAD = { ...UNREAD, mb_2: { ...UNREAD.mb_1 } };

/** 120 days before ISO: outside a 90-day window from a baseline at ISO. */
const QUIET = "2026-04-06T09:00:00.000Z";

const letter = (id: string, seq: number) => ({
  type: "message", op: "create", id, seq, updatedAt: ISO,
  entity: {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `subject of ${id}`, from: { name: "Quiet Stranger", address: "quiet@stranger.invalid" },
    to: [], cc: [], date: QUIET, folder: "ohmail/Screener", snippet: `snippet of ${id}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  },
});
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const world = (): Response => json({
  changes: { creates: [letter("q1", 1), letter("q2", 2)], updates: [], moves: [], deletes: [] },
  cursor: "c1", hasMore: false, serverTime: ISO,
});

const rowIds = (c: HTMLElement): string[] => [...c.querySelectorAll(".row[data-id]")].map((n) => n.getAttribute("data-id") ?? "");

let consentAsks = 0;
let facts: MailboxFacts[] = [];
const box = (id: string, role: "organizer" | "reader", over: Partial<MailboxFacts> = {}) =>
  mailbox({ id, organizerRole: role, lastSyncAt: ISO, ...over });

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  consentAsks = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/consent") && (init?.method ?? "GET") === "GET") consentAsks += 1;
    return inner(input, init);
  }) as typeof globalThis.fetch;
  answerSyncWith(world);
});
afterEach(async () => { await teardownShellEnv(); });

const mount = () => mountShell([], { probe: async () => facts });
const poll = () => tick(31_000);

describe("the facts' roles re-ask GET /consent when the window answer is older", () => {
  it("reader -> organizer with no /sync rows: one more ask, and History lists the quiet stranger", async () => {
    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: UNREAD });
    facts = [box("mb_1", "reader")];
    const el = await mount();
    await poll();
    expect(consentAsks, "boot asks once").toBe(1);
    await goTo("screener");
    expect(rowIds(el).some((id) => id === "q1" || id === "q2"),
      "the fixture is broken: the whole-folder window should list the stranger as waiting").toBe(true);

    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: OWN_90 });
    facts = [box("mb_1", "organizer")];
    await poll();
    await poll();
    expect(consentAsks, "the promotion never re-asked the window").toBe(2);
    await goTo("screener");
    expect(rowIds(el), "the Screener still lists a sender the server's window retired").not.toContain("q1");
    expect(rowIds(el)).not.toContain("q2");
    await goTo("history");
    expect(rowIds(el)).toEqual(expect.arrayContaining(["q1", "q2"]));
  });

  it("CONTROL: polls that move only counters ask nothing", async () => {
    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: OWN_90 });
    facts = [box("mb_1", "organizer")];
    await mount();
    await poll();
    const settled = consentAsks;
    for (let i = 0; i < 3; i++) {
      facts = [box("mb_1", "organizer", { lastSyncAt: new Date(Date.parse(ISO) + i * 1000).toISOString() })];
      await poll();
    }
    expect(consentAsks).toBe(settled);
  });

  it("the add path: a new mailbox the answer lacks asks once, and its promotion asks once more", async () => {
    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: OWN_90 });
    facts = [box("mb_1", "organizer")];
    await mount();
    await poll();
    const settled = consentAsks;
    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: { ...OWN_90, mb_2: UNREAD.mb_1 } });
    facts = [box("mb_1", "organizer"), box("mb_2", "reader")];
    await poll();
    await poll();
    expect(consentAsks, "the added mailbox's window was never asked for").toBe(settled + 1);
    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: { ...OWN_90, mb_2: OWN_90.mb_1 } });
    facts = [box("mb_1", "organizer"), box("mb_2", "organizer")];
    await poll();
    await poll();
    expect(consentAsks, "the second mailbox's promotion never re-asked").toBe(settled + 2);
  });

  it("CONTROL: entries without a source never ask", async () => {
    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: { mb_1: { baselineAt: null, dormancyDays: 60, scope: "window" } } });
    facts = [box("mb_1", "reader")];
    await mount();
    await poll();
    const settled = consentAsks;
    facts = [box("mb_1", "organizer")];
    await poll();
    await poll();
    expect(consentAsks).toBe(settled);
  });

  it("CONTROL: an answer that stays inconsistent is asked about once, not in a loop", async () => {
    answerConsentWith({ onboardingCompletedAt: ISO, screeningByMailbox: BOTH_UNREAD });
    facts = [box("mb_1", "reader"), box("mb_2", "reader")];
    await mount();
    await poll();
    const settled = consentAsks;
    facts = [box("mb_1", "organizer"), box("mb_2", "reader")];
    for (let i = 0; i < 5; i++) await poll();
    expect(consentAsks).toBe(settled + 1);
  });
});
