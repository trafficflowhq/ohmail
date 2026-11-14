/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISO, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import en from "../messages/en.json";

/**
 * A SCREENER PRESS ON AN INSTALL THAT ONLY READS A MAILBOX NOTHING ORGANIZES. The shape the tester
 * met on a self-hosted web reader with setup cancelled: the press said "filed" with Undo, the write
 * left after the undo window and the server refused it 409 `no_organizer`. The press now says so
 * first and sends nothing; where the roster is a pass behind, the refusal names its reason.
 */

const SCREENER = "ohmail/Screener";
const WHY = en.ohbox.whyRefused;
const NOBODY_409 = () => new Response(JSON.stringify({
  error: {
    code: "organized_elsewhere", message: "nothing organizes this mailbox right now",
    details: { by: { kind: null, name: null, since: null }, reason: "no_organizer" },
  },
}), { status: 409, headers: { "content-type": "application/json" } });

interface Change { type: string; op: string; id: string; seq: number; updatedAt: string; entity: unknown }
let log: Change[] = [];
let posts: string[] = [];

/** One stranger's letter, held at the gate or past it in the INBOX; every write refused. */
function world(folder: string): void {
  log = [{
    type: "message", op: "create", id: "m1", seq: 1, updatedAt: ISO,
    entity: {
      id: "m1", accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
      subject: "subject of m1", from: { name: "Stranger", address: "stranger@example.invalid" },
      to: [], cc: [], date: ISO, folder, snippet: "snippet", unread: true, hasAttachments: false,
      attachmentCount: 0, sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
    },
  }];
  posts = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/sync")) {
      const since = Number(new URL(url, "http://x").searchParams.get("since") ?? "0") || 0;
      const rows = url.includes("types=rule") ? [] : log.filter((c) => c.seq > since);
      return new Response(JSON.stringify({
        changes: { creates: rows, updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: ISO,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/consent")) {
      return new Response(JSON.stringify({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
        counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method !== "GET" && /\/(screener|rules|messages)\b/.test(url)) {
      posts.push(`${method} ${url.replace(/^.*\/api/, "")}`);
      return NOBODY_409();
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** File the row through its own quick-adjust menu, as `screener-decision-holds` does. */
async function fileToOhbox(c: HTMLElement): Promise<void> {
  const slot = c.querySelector(`.row[data-id="m1"]`)?.closest(".row-slot");
  if (!slot) throw new Error("the stranger is not waiting in the Screener");
  slot.querySelector<HTMLButtonElement>(".scn-act-more")!.click();
  await tick(0);
  slot.querySelectorAll<HTMLButtonElement>(".scn-act-dest")[0]!.click();
  await tick(0);
}

/** Setup cancelled: a reader, nothing holds it, nobody agreed to organize it. */
const unconsented = (): MailboxFacts[] => [mailbox({
  id: "mb_1", lastSyncAt: ISO, organizerRole: "reader", organizedBy: null, organizerState: null,
  organizeConsentedAt: null,
} as Partial<MailboxFacts>)];
const behind = (): MailboxFacts[] => [mailbox({ id: "mb_1", lastSyncAt: ISO, organizerRole: "organizer" } as Partial<MailboxFacts>)];

vi.setConfig({ testTimeout: 30_000 });

for (const folder of [SCREENER, "INBOX"]) describe(`the press says so before any write where nothing organizes the mailbox (${folder})`, () => {
  beforeEach(() => { window.localStorage.clear(); installShellEnv(); world(folder); });
  afterEach(teardownShellEnv);
  it(`${folder === SCREENER ? "held at the gate" : "past the gate"}: no "filed", no Undo, nothing sent`, async () => {
      const c = await mountShell(unconsented());
      await tick(0);
      await goTo("screener");
      await tick(50);
      await fileToOhbox(c);
      expect(c.textContent, "the press said nothing about why").toContain(WHY.nobody);
      expect(c.textContent, "the press did not say nothing was filed").toContain(en.screener.notFiled);
      expect(c.textContent, "the press claimed a filing").not.toContain("files there automatically");
      const undo = [...c.querySelectorAll("button")].filter((b) => b.textContent?.trim() === en.screener.toastUndo);
      expect(undo.length, "an Undo was offered for a press that did nothing").toBe(0);
      await goTo("ohbox");
      await tick(10_000);
      expect(posts, "a write left for a mailbox nothing organizes").toEqual([]);
  });
});

for (const folder of [SCREENER, "INBOX"]) describe(`where the roster is a pass behind, the refusal names its reason (${folder})`, () => {
  beforeEach(() => { window.localStorage.clear(); installShellEnv(); world(folder); });
  afterEach(teardownShellEnv);
  it(`${folder === SCREENER ? "the refused decide" : "the refused rule"} carries the reason`, async () => {
      const c = await mountShell(behind());
      await tick(0);
      await goTo("screener");
      await tick(50);
      await fileToOhbox(c);
      await goTo("ohbox");
      await tick(200);
      expect(posts.length, "the premise: the write went and was refused").toBeGreaterThan(0);
      expect(c.textContent, "the correction named no reason").toContain(WHY.nobody);
  });
});
