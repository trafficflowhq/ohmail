/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import { LOADING_GRACE_MS } from "@ohmail/app-logic/session/loading-grace";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import {
  ISO,
  answerSyncWith,
  goTo,
  installShellEnv,
  mailbox,
  mountShell,
  page,
  teardownShellEnv,
  textOf,
  tick,
} from "./fixtures/live-walk-shell";

/**
 * ═══ A DRAIN THAT COMPLETED IS NOT A MAILBOX THAT HAS BEEN READ ════════════════════════════
 *
 * Measured twice on the managed web (2026-09-18, cold browser profiles): the Ohbox rendered
 * **"Nothing in your Ohbox."** with an unread count far below the account's own,
 * then presented a PARTIAL count as settled fact — a fraction of the unread at a partial replay, settling
 * short of the truth — while the rail was saying "Syncing your mail. N messages so far" the whole time. Two
 * surfaces contradicting each other about one account, and the list pane was the one lying.
 *
 * `pending-is-not-empty.test.ts` owns the FIRST window (no drain has completed). This file owns
 * the second, which that one cannot see: the drain HAS completed and the import has not, so
 * `settled` is true and the pane spoke. The reading is `@ohmail/client-engine`'s `listSurface`
 * and `countWhen` over `MailState.settled` and `MailState.owed`.
 */

const OHBOX = messages.ohbox as unknown as Record<string, string>;
/** The header's claim about the mailbox. The number is `unreadIds.length`. */
const UNREAD_META = /\d[\d,]*\s+unread/;

/**
 * A mailbox the server has NOT stamped as imported, holding more than this device has taken in
 * — the ladder's `importing` key, which is exactly the rail sentence the walk recorded. The
 * fields are the wire's: `initialImportCompletedAt === null` arms the import floor,
 * `hostedMessageCount` is the account's own total and `messageCount` what the server has stored.
 */
const importing = (over: Partial<MailboxFacts> = {}): MailboxFacts =>
  mailbox({
    lastSyncAt: ISO,
    initialImportCompletedAt: null,
    messageCount: 550,
    hostedMessageCount: 3615,
    ...over,
  } as Partial<MailboxFacts>);

/** The same mailbox once the import has ended: stamped, and the device holds what it holds. */
const imported = (): MailboxFacts =>
  mailbox({
    lastSyncAt: ISO,
    initialImportCompletedAt: ISO,
    messageCount: 3615,
    hostedMessageCount: 3615,
  } as Partial<MailboxFacts>);

describe("the Ohbox withholds its emptiness and its count while the import is in flight", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  /**
   * THE MEASURED SHAPE. The drain settles on an empty page — which is what a cold client sees
   * when the server has not yet handed it the account — while the mailbox facts say the import
   * is running. `settled` is true, so every guard keyed on `settled` alone lets the pane speak.
   *
   * Mutation: `owed: state.key === "importing"` → `owed: false` in `deriveMailState`, or drop
   * `pending: owed` from `OhboxView`'s `listInput`. Either restores the measured defect and
   * this case goes red on the first assertion.
   */
  it("says nothing about emptiness over a mailbox the account is still importing", async () => {
    // Mail in the mirror, none of it in the OHBOX — mail from senders nobody has screened sits
    // in the Screener pile. That is the measured shape: thousands of messages mirrored and an Ohbox
    // list that is empty for the first seconds, which is the window the pane spoke into. It is
    // also the import floor's own premise (`mirrored > 0`): a PARTIAL mailbox, not an empty one.
    answerSyncWith(() => page(3, "ohmail/Screener"));
    const el = await mountShell([importing()]);
    await tick(LOADING_GRACE_MS * 4);

    expect(el.querySelectorAll(".row[data-id]").length, "the premise: no OHBOX rows").toBe(0);

    expect(textOf(el), "the pane called a mid-import mailbox empty")
      .not.toContain(OHBOX.emptyPlain);
    // All three arms of the empty pane, because a fix that closed one would be the same lie in
    // the other two — which is how the shipped one survived: `emptyPlain` was gated and the
    // header count was not.
    expect(textOf(el), "the pane called a mid-import mailbox empty, in the filed arm's words")
      .not.toContain(OHBOX.emptyFiledTitle);
    expect(textOf(el), "the pane called a mid-import mailbox empty, in the Screener's words")
      .not.toContain(OHBOX.emptyScreenerTitle);
    expect(textOf(el), "the header counted a mailbox that was still arriving")
      .not.toMatch(UNREAD_META);
    // And it is not silent: the pane says what it is doing, past the grace.
    expect(textOf(el), "a blank column, which is the defect this answers wearing a hat")
      .toContain(OHBOX.loading);
    // The rail is the one surface allowed to say WHY — and it is saying it.
    expect(textOf(el), "no surface explained why the list is withheld")
      .toContain("Syncing your mail");
  });

  /**
   * THE SECOND HALF, and the one `metaWhen` cannot see: rows have landed, so the surface is
   * `content` — and the count is STILL a claim about the whole pile. This is the review's
   * "96 unread at 550 replayed", reproduced with rows on screen.
   *
   * Mutation: replace `countWhen(listInput, …)` in `OhboxView`'s `meta` with the old
   * `!settled && all.length === 0 ? undefined : …` and this goes red.
   */
  it("withholds the count once rows land, while the rest of the mailbox is still coming", async () => {
    answerSyncWith(() => page(3, "INBOX"));
    const el = await mountShell([importing()]);
    await tick(LOADING_GRACE_MS * 4);

    expect(el.querySelectorAll(".row[data-id]").length, "the premise: rows landed")
      .toBeGreaterThan(0);
    expect(textOf(el), "a partial count was stated as the mailbox's own")
      .not.toMatch(UNREAD_META);
    // The rows themselves are never withheld — real mail beats a silhouette.
    expect(textOf(el), "the rows that HAD arrived were hidden").not.toContain(OHBOX.loading);
  });

  /**
   * AND IT ALL COMES BACK. A guard that only asserts absences is indistinguishable from a
   * feature deleted: with the import over, the count, the empty sentence and the older-mail
   * tail are owed and this pins that they return.
   */
  it("states the count and the emptiness the moment the import is over", async () => {
    const el = await mountShell([imported()]);
    await tick(LOADING_GRACE_MS * 4);

    expect(textOf(el), "the empty state never came back").toContain(OHBOX.emptyPlain);
    expect(textOf(el), "the count never came back").toMatch(UNREAD_META);
    expect(textOf(el), "the pane was left spinning over a settled mailbox")
      .not.toContain(OHBOX.loading);
  });

  /**
   * THE CLAIM THAT NEVER SETTLED. "Syncing your mail. N messages so far" stood for over
   * an hour against an account holding 3,615, because the server's `initial_import_completed_at`
   * is written by a no-backlog cycle nothing guarantees. The device's own evidence ends it:
   * denominator known and reached ⇒ nothing is importing (`mirrorCaughtUp`).
   *
   * Mutation: drop `!mirrorCaughtUp(mailboxes, pulled)` from the import-floor arm in `climb`
   * and the sentence comes back over a mirror that has it all — red here.
   */
  it("stops claiming an import once the device holds what the account holds", async () => {
    answerSyncWith(() => page(3, "ohmail/Screener"));
    const el = await mountShell([
      // Unstamped, exactly as the measured mailbox was — and caught up.
      importing({ messageCount: 3615, hostedMessageCount: 3615 } as Partial<MailboxFacts>),
    ]);
    await tick(LOADING_GRACE_MS * 4);

    expect(textOf(el), "an in-progress claim with nothing in progress behind it")
      .not.toContain("Syncing your mail");
    // …and the pane is free to speak again, which is what makes the two halves one fix. With
    // senders at the gate the honest arm is the Screener's, not the plain one.
    expect(textOf(el), "the list stayed withheld behind a claim that had ended")
      .toContain(OHBOX.emptyScreenerTitle);
  });

  /**
   * THE POSITIVE CONTROL FOR THE END CONDITION: still behind, still claiming. Without this the
   * case above passes for a `mirrorCaughtUp` that returns `true` for everything.
   */
  it("keeps the claim while the device is genuinely behind the account", async () => {
    answerSyncWith(() => page(3, "ohmail/Screener"));
    const el = await mountShell([importing()]);
    await tick(LOADING_GRACE_MS * 4);
    expect(textOf(el), "a real import stopped being announced").toContain("Syncing your mail");
  });

  /**
   * AND WITH NO DENOMINATOR ON THE WIRE — an older server, or counts nobody asked for — the
   * floor is exactly what it was. `mirrorCaughtUp` is `false` there, never `true` by absence:
   * a missing number is not evidence that the import is done.
   */
  it("reads a missing total as no answer, not as caught up", async () => {
    answerSyncWith(() => page(3, "ohmail/Screener"));
    const el = await mountShell([
      mailbox({ lastSyncAt: ISO, initialImportCompletedAt: null } as Partial<MailboxFacts>),
    ]);
    await tick(LOADING_GRACE_MS * 4);
    expect(textOf(el), "an absent count was read as a finished import")
      .toContain("Syncing your mail");
  });
});

/**
 * THE MULTI-PAGE ARM. A drain that pages does not publish between every page (the backlog's
 * publish cadence), so this window is usually invisible — which is why it gets a case of its
 * own rather than being assumed covered: the pane must say nothing about emptiness while the
 * walk is in flight, whatever the cadence does.
 */
describe("a drain still walking its pages states nothing", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("renders the pending state, not an empty one, between pages", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const u = String(input);
      if (u.includes("types=rule")) return page(0);
      if (u.includes("/sync")) {
        calls += 1;
        if (calls === 1) {
          const body = await page(2, "INBOX").json();
          return new Response(JSON.stringify({ ...body, hasMore: true }), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        // Page two never lands — the walk is held open for as long as this case looks.
        await new Promise<void>((r) => { release = r; });
        return page(0);
      }
      if (u.includes("/consent")) {
        return new Response(
          JSON.stringify({
            seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60,
            counts: { decidedSenders: 0, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const el = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(LOADING_GRACE_MS * 4);

    expect(calls, "the premise: the walk asked for a second page").toBeGreaterThan(1);
    expect(textOf(el), "the pane called a mailbox empty mid-walk").not.toContain(OHBOX.emptyPlain);
    expect(textOf(el), "the header counted a mailbox mid-walk").not.toMatch(UNREAD_META);
    expect(textOf(el), "the pane went silent mid-walk").toContain(OHBOX.loading);
    if (release) (release as () => void)();
  });
});

/**
 * ═══ THE WARM REOPEN — INCIDENT-021's own shape ═════════════════════════════════════════════
 *
 * Measured on the hosted service (2026-09-20, warm profile): a reopened tab hydrates its whole mirror
 * from IndexedDB, the old drain stamp settles every pane, and the catch-up drain is still in
 * flight — `settled` true via the stamp, no import arm able to fire — and all three piles
 * asserted their empty copy over a mailbox full of hydrated messages. The store below IS that state:
 * filed mail, a 90-minute-old `LAST_DRAIN_AT_META`, and a `/sync` that never answers.
 *
 * Mutation: restore `owed: state.key === "importing"` in `deriveMailState` — red on the
 * emptiness assertions.
 */
describe("a warm reopen mid-catch-up never asserts emptiness", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("renders the pending state over a hydrated mirror while the catch-up runs", async () => {
    const { HttpAdapter, LAST_DRAIN_AT_META, MemoryMirrorStore, OhmailEngine } =
      await import("@ohmail/client-engine");
    const store = new MemoryMirrorStore();
    await store.applyResponse(await page(3, "ohmail/Screener").json());
    await store.setMeta(LAST_DRAIN_AT_META, new Date(Date.parse(ISO) - 90 * 60_000).toISOString());

    const engine = new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "/api",
        fetch: async (url: string) => {
          // The catch-up held open for as long as the case looks — the reported minutes.
          if (String(url).includes("/sync")) return new Promise<Response>(() => {});
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      }),
      store,
    });

    const el = await mountShell([mailbox({ lastSyncAt: ISO } as Partial<MailboxFacts>)], { engine });
    await tick(LOADING_GRACE_MS * 4);

    expect(el.querySelectorAll(".row[data-id]").length, "the premise: filed mail, no OHBOX rows").toBe(0);
    expect(textOf(el), "the pane asserted emptiness mid-catch-up (INCIDENT-021)")
      .not.toContain(OHBOX.emptyPlain);
    expect(textOf(el), "the filed arm asserted emptiness mid-catch-up")
      .not.toContain(OHBOX.emptyFiledTitle);
    expect(textOf(el), "the header counted a mirror still catching up").not.toMatch(UNREAD_META);
    expect(textOf(el), "a blank column instead of the pending sentence").toContain(OHBOX.loading);

    // The same claim's two other homes (the reported second and third screenshots): the streams'
    // header sentence is the ListPane meta's ungated twin, gated through the same reading now.
    const NOTHING_NEW = "Nothing new since you were here";
    await goTo("reads");
    expect(textOf(el), "Reads asserted 'Nothing new' mid-catch-up").not.toContain(NOTHING_NEW);
    await goTo("receipts");
    expect(textOf(el), "Receipts asserted 'Nothing new' mid-catch-up").not.toContain(NOTHING_NEW);
  });
});
