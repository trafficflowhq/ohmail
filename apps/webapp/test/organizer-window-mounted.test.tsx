/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

const WINDOW_UNREAD = {
  mb_1: { baselineAt: null, dormancyDays: 60, scope: "all_time", source: "unread", holder: { kind: "local", name: "Studio Mac", since: null }, asOf: null },
};
const WINDOW_ORGANIZER = {
  mb_1: { baselineAt: ISO, dormancyDays: 30, scope: "window", source: "organizer", holder: { kind: "local", name: "Studio Mac", since: null }, asOf: ISO },
};

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const pageOf = (creates: unknown[], cursor: string): Response =>
  json({ changes: { creates, updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: ISO });
const profileRow = (seq: number) => ({
  type: "mailbox_profile", op: "create", id: "mb_1", seq, updatedAt: ISO,
  entity: { mailboxId: "mb_1", rules: [], asOf: ISO, from: { kind: "local", name: "Studio Mac", since: null }, updatedAt: ISO },
});

const words = (el: HTMLElement): string => el.textContent ?? "";

function openScreener() {
  window.location.hash = "#/screener";
  return mountShell([mailbox()]);
}

/** `GET /consent` asks this mount made — read so a case can tell a re-ask from a boot read. */
let consentAsks = 0;
beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  consentAsks = 0;
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/consent") && (init?.method ?? "GET") === "GET") consentAsks += 1;
    return inner(input, init);
  }) as typeof globalThis.fetch;
});
afterEach(async () => {
  await teardownShellEnv();
});

describe("a mailbox_profile row re-asks GET /consent", () => {
  it("the unread sentence is gone once the organizer's document is mirrored — no reload", async () => {
    answerConsentWith({ screeningByMailbox: WINDOW_UNREAD });
    let phase: "boot" | "profile" | "idle" = "boot";
    answerSyncWith(() => {
      if (phase === "boot") { phase = "idle"; return pageOf([], "c1"); }
      if (phase === "profile") { phase = "idle"; return pageOf([profileRow(2)], "c2"); }
      return pageOf([], "cIdle");
    });
    const el = await openScreener();
    await tick(30_000);
    expect(words(el), "the boot answer's sentence never rendered — the fixture is broken")
      .toContain("Studio Mac has not shared its screening settings yet");

    // The reader's cycle mirrors the organizer's document: the server answers with its window, and
    // the ONLY thing that reaches this shell is the mailbox_profile row on the next drain.
    answerConsentWith({ screeningByMailbox: WINDOW_ORGANIZER });
    phase = "profile";
    await tick(30_000);
    expect(words(el), "the shell kept a window the server no longer answers").not.toContain("has not shared its screening settings yet");
  });

  it("a LATER document moves it too: the organizer's window replaced by an older build's, said at once", async () => {
    answerConsentWith({ screeningByMailbox: WINDOW_ORGANIZER });
    let phase: "boot" | "first" | "older" | "idle" = "boot";
    answerSyncWith(() => {
      if (phase === "boot") { phase = "idle"; return pageOf([], "c1"); }
      if (phase === "first") { phase = "idle"; return pageOf([profileRow(2)], "c2"); }
      if (phase === "older") { phase = "idle"; return pageOf([profileRow(5)], "c5"); }
      return pageOf([], "cIdle");
    });
    const el = await openScreener();
    await tick(30_000);
    // The organizer's first document is mirrored: the first observed stamp asks once.
    phase = "first";
    await tick(30_000);
    expect(words(el)).not.toContain("older ohmail");
    const settled = consentAsks;
    answerConsentWith({ screeningByMailbox: { mb_1: { ...WINDOW_ORGANIZER.mb_1, source: "unstated", scope: "all_time", baselineAt: null } } });
    phase = "older";
    await tick(30_000);
    expect(consentAsks, "the second document did not ring GET /consent").toBe(settled + 1);
    expect(words(el), "a second document did not re-ask").toContain("Studio Mac runs an older ohmail");
  });

  it("CONTROL: with no profile row the shell does not re-ask, and the boot answer stands", async () => {
    answerConsentWith({ screeningByMailbox: WINDOW_UNREAD });
    answerSyncWith(() => pageOf([], "cIdle"));
    const el = await openScreener();
    await tick(30_000);
    answerConsentWith({ screeningByMailbox: WINDOW_ORGANIZER });
    await tick(30_000);
    expect(words(el)).toContain("has not shared its screening settings yet");
  });
});
