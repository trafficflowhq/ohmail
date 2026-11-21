/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { consentVia } from "../../desktop/src/consent-wire";
import type { ConsentReadFailure, ConsentTransport } from "@ohmail/app-logic/consent/consent-state";

/**
 * THE PAIRED DESKTOP'S OHBOX FILES MAIL BY RULE WHILE ITS CONSENT READ FAILS (FIX-025).
 *
 * A Cloud-paired desktop whose forwarded `GET /consent` never answered drew its Ohbox with the
 * partition off: every unread INBOX message, including mail from senders ruled to `ohmail/Reads`.
 * This mounts the shipped shell over the paired door's own consent calls (`consentVia`, the wire
 * `consentOverBridge` spreads) with a fixture of that shape, and walks the read through a 503, a
 * body with no window, and an answer.
 */

type Phase = "unavailable" | "no-window" | "answered";
let phase: Phase;
let consentAsks: number;
let reports: ConsentReadFailure[];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The engine's forward, as the paired window reaches it: 503 while offline, then the account. */
async function engineFetch(path: string): Promise<Response> {
  if (path !== "/consent") return json(404, { error: { code: "not_found" } });
  consentAsks += 1;
  if (phase === "unavailable") return json(503, { error: { code: "offline_read_only", message: "offline", retryable: true } });
  if (phase === "no-window") return json(200, { seedConfirmedAt: ISO });
  return json(200, {
    seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60, screeningBaselineAt: null,
    autoSuggestAt: null, counts: { activeUndecidedSenders: 0 },
  });
}

const paired = (): ConsentTransport => ({
  ...consentVia(engineFetch),
  foldersStorable: true,
  readFailed: (report) => { reports.push(report); },
});

let n = 0;
const message = (o: { id: string; from: string; sensitive?: boolean }) => ({
  type: "message", op: "create", id: o.id, seq: ++n, updatedAt: ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `subject of ${o.id}`, from: { name: null, address: o.from }, to: [], cc: [],
    date: ISO, arrivedAt: ISO, folder: "INBOX", snippet: "", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: o.sensitive
      ? { sensitive: true, category: "security", no_ai: true, no_forward: true, no_kb: true, priority: false }
      : { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  },
});
const rule = (address: string, destination: string) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq: ++n, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination, priority: 0,
    provenance: "user", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO, updatedAt: ISO,
  },
});

/**
 * 4 unread INBOX messages from two INBOX-ruled senders, and 14 from six senders each with exactly
 * one rule to `ohmail/Reads`, 11 of them flagged sensitive (security mail the organizer keeps in
 * the INBOX and every client files by rule).
 */
function ruledWorld(): Response {
  n = 0;
  const creates: unknown[] = [];
  for (const s of ["kept-a@example.invalid", "kept-b@example.invalid"]) {
    creates.push(rule(s, "INBOX"));
    for (let i = 0; i < 2; i += 1) creates.push(message({ id: `kept-${s[5]}-${i}`, from: s }));
  }
  let flagged = 0;
  [3, 3, 2, 2, 2, 2].forEach((count, k) => {
    const s = `reads-${k}@example.invalid`;
    creates.push(rule(s, "ohmail/Reads"));
    for (let i = 0; i < count; i += 1) {
      creates.push(message({ id: `reads-${k}-${i}`, from: s, sensitive: flagged < 11 }));
      flagged += 1;
    }
  });
  return json(200, { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c1", hasMore: false, serverTime: ISO });
}

/**
 * The Ohbox's unread count, as the rail states it. Today's rail said it in a tooltip ("4 unread"); the new rail's
 * entry says it in its accessible name ("Ohbox 4", the kit's `RailEntry`), and draws no tooltip (RE-POINTED, share
 * ohbox-2: the shell is the one there is, `_mail-shell.tsx` through the shared fixture; expectations as they stood).
 */
function ohboxUnread(): number {
  const named = [...document.querySelectorAll<HTMLElement>('[data-rail-id="ohbox"] button')]
    .map((el) => /^Ohbox (\d+)$/.exec(el.getAttribute("aria-label") ?? ""))
    .filter((m): m is RegExpExecArray => m !== null);
  expect(named.length, "the rail's Ohbox item was not found").toBeGreaterThan(0);
  return Number(named[0]![1]);
}

describe("the paired desktop's Ohbox while its consent read fails", () => {
  beforeEach(() => {
    installShellEnv();
    // No remembered account: the desktop window has no owner cookie, so no boot cache.
    document.cookie = "tf_owner=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    window.localStorage.clear();
    answerSyncWith(ruledWorld);
    phase = "unavailable";
    consentAsks = 0;
    reports = [];
  });
  afterEach(async () => {
    await teardownShellEnv();
  });

  /* INVERTED by ARCH-R902: a rule that moved nothing leaves the letter in the INBOX,
     so the Ohbox holds all 18 in every phase; this pinned 4 while the rules presented the rest in
     Reads. What it defended stands: the three phases agree with the answer. */
  it("the control: a read that answers at once presents the 18 the web shows", async () => {
    phase = "answered";
    await mountShell([mailbox({ address: "me@example.invalid", lastSyncAt: ISO })], { consentTransport: paired() });
    await tick(0);
    expect(ohboxUnread()).toBe(18);
    expect(reports).toEqual([]);
  }, 30_000);

  it("files the ruled mail in every phase: 503, a body with no window, then the answer", async () => {
    await mountShell([mailbox({ address: "me@example.invalid", lastSyncAt: ISO })], { consentTransport: paired() });
    await tick(0);
    expect(consentAsks, "the boot read was not issued").toBeGreaterThanOrEqual(1);
    expect(ohboxUnread(), "503: the INBOX letters are presented in the Ohbox").toBe(18);

    phase = "no-window";
    await tick(2_000);
    expect(consentAsks, "no retry at 2 s").toBeGreaterThanOrEqual(2);
    expect(ohboxUnread(), "a body with no window: the INBOX letters are presented in the Ohbox").toBe(18);

    phase = "answered";
    await tick(10_000);
    expect(consentAsks, "no retry at 10 s").toBeGreaterThanOrEqual(3);
    expect(ohboxUnread(), "answered").toBe(18);

    const asked = consentAsks;
    await tick(400_000);
    expect(consentAsks, "a known state is not asked again by the ladder").toBe(asked);

    // One report per failure: the status or the shape, never the body.
    expect(reports).toEqual([
      { attempt: 1, reason: "refused", status: 503 },
      { attempt: 2, reason: "shape" },
    ]);
  }, 30_000);
});
