/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THE FIRST IMPORT, SAID OUT LOUD, WHEREVER YOU ARE STANDING.
 *
 * ── WHAT THIS FILE HAS TO BITE ──────────────────────────────────────────────────────────
 *
 * "Waiting for first sync" shipped, and it was measured on a live account on
 * 2026-08-03 sitting on screen for THIRTY MINUTES while mail kept arriving — still climbing
 * steadily when checked. The Ohbox had a counter for this and it was
 * SILENT throughout, because it was gated on `SyncStatus.bootstrapping`, which goes false as
 * soon as this TAB's first drain lands — seconds.
 *
 * Both halves of that are wiring bugs, so every assertion here is made through the REAL
 * `AppShell`, against a real `HttpAdapter` whose `/sync` is driven page by page, with a real
 * mailbox probe. A test that mounted the ladder directly could not fail for either bug.
 *
 * ── THE MUTATION FOR EACH GUARD ─────────────────────────────────────────────────────────
 *
 * Recorded in the project's design notes, one row per mutation, watched red and restored. A
 * guard nobody has watched fail is not evidence.
 *
 * ── HARNESS ACCOMMODATIONS, STATED ──────────────────────────────────────────────────────
 *
 * React as a global and `NEXT_PUBLIC_API_BASE` before any dynamic import: both for the reasons
 * `sync-liveness-shell.test.ts` sets out. `matchMedia`, `CSS.escape`, `scrollIntoView` and
 * `IntersectionObserver` are jsdom gaps, stubbed at their narrowest, exactly as
 * `sync-visible.test.ts` does — `matches: false` is the desktop layout, and an observer that
 * never fires means nothing marks itself seen by scrolling, which is right for a document
 * nobody has scrolled.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * EVERY CASE IS A FAKE-TIMER WALK through the real shell, so what it asserts never depends on the
 * wall clock, which only bounds a hang. The heaviest drives 73 polls and 290 shell commits,
 * so the 5 s default read it red at load. The walk's COST is read by count instead (that case asserts its
 * commit ceiling); the module graph loads in `beforeAll`.
 */
const WALK_MS = 30_000;
/* THE CEILING: a fixed commit count over this walk on React (stepped acts at the production
   pace), and the old bound's headroom ratio over it. A poll is ONE commit only
   while both hold: the drain publishes its page and its freshness stamp in one notify, and
   `MailStateProvider` folds the growth in the render that observes it. Either alone reads 358, so
   a re-split notify or the fold moved back into an effect reads red here. */
const WALK_COMMITS_MAX = 340;
vi.setConfig({ testTimeout: WALK_MS });

const ISO = "2026-08-04T09:00:00.000Z";

/** One real-shaped row; the views read `from.address`, `subject` and `folder` for real. */
const message = (id: string, folder: string, seq: number) => ({
  type: "message",
  op: "create",
  id,
  seq,
  updatedAt: ISO,
  entity: {
    id,
    accountId: "acct_live_1",
    mailboxId: "mb_1",
    threadId: null,
    messageIdHeader: null,
    subject: `subject of ${id}`,
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date: ISO,
    folder,
    snippet: `snippet of ${id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: {},
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: ISO,
  },
});

/**
 * A rule — one screening decision, about one sender.
 *
 * The shell presents mail by WHO SENT IT, so an account with no rules has decided about nobody
 * and every undecided INBOX message presents in the Screener rather than the Ohbox. That is
 * the correct reading of an account that has never been through onboarding; it is not the
 * account this file is about, which is a settled mailbox with mail in its piles. Emitting a
 * rule per sender makes the fixture an ONBOARDED account, which is the state these assertions
 * have always meant.
 */
const rule = (address: string, seq: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  },
});

let seq = 0;
/** A page of `n` new messages in `folder`, with a fresh cursor so the engine advances. */
const page = (n: number, folder = "INBOX", hasMore = false): Response => {
  const rows = Array.from({ length: n }, () => {
    seq += 1;
    return message(`m${seq}`, folder, seq);
  });
  // Consent for exactly the senders this page invents, in the SAME page: a message whose rule
  // has not arrived yet spends a render in the Screener, and these walks assert on the frame
  // after the drain.
  //
  // ONLY for a page filed into the INBOX. A page addressed to `ohmail/Screener` is mail from
  // people nobody has screened — that is the whole point of the tests that ask for one, and
  // consenting those senders would pull their mail into the Ohbox and delete the state under
  // test. The condition IS the distinction the consent model draws.
  const creates = folder === "INBOX"
    ? [...rows, ...rows.map((m) => { seq += 1; return rule(m.entity.from.address, seq); })]
    : rows;
  return new Response(
    JSON.stringify({
      changes: { creates, updates: [], moves: [], deletes: [] },
      cursor: `c${seq}`,
      hasMore,
      serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const empty = (): Response => page(0);

/**
 * A page that DELETES ids — how a Screener backfill's moves reach this client as a FALL.
 *
 * `apply.ts` tombstones on `op: "delete"` and `store.list()` drops tombstones, so the mirror
 * count genuinely goes DOWN — which is the only way to drive the first defect through the real
 * shell. The seqs continue past the creates', or the "never let an older-or-equal seq overwrite"
 * guard would discard them and the mirror would not move at all.
 */
const removing = (ids: string[]): Response => {
  const base = seq;
  seq += ids.length;
  return new Response(
    JSON.stringify({
      changes: {
        creates: [],
        updates: [],
        moves: [],
        deletes: ids.map((id, i) => ({
          type: "message",
          op: "delete",
          id,
          seq: base + i + 1,
          updatedAt: ISO,
        })),
      },
      cursor: `c${seq}`,
      hasMore: false,
      serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

type Answer = () => Response | Promise<Response>;

let answer: Answer = empty;
let facts: MailboxFacts[] | null = null;
/** When true the probe REJECTS, which must never be read as "this account has no mailboxes". */
let probeFails = false;
let probeCalls = 0;
let originalFetch: typeof globalThis.fetch;
let roots: Root[] = [];
/** The walk's work, by count: `/sync` answers served and commits of the mounted shell. */
let polls = 0;
let shellCommits = 0;

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "desk@trafficflow.invalid",
  status: "connected",
  errorCode: null,
  // (mail 0027) — WHY a `disabled` mailbox is disabled, when the organizer lease decided it.
  // Null is both the healthy case and the ordinary user disconnect; `deriveMailState` reads
  // `typeof === "string"`, so an omitted field could not quietly turn every disconnect here into
  // an organizer conflict.
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: null,
  // Default is a FINISHED import, so the growth-driven states below are exercised
  // by the mirror moving — not by the import floor, which a case sets explicitly when it wants it.
  initialImportCompletedAt: ISO,
  createdAt: ISO,
  ...over,
});

/**
 * A blocked mailbox AS THE WIRE CAN ACTUALLY PRODUCE ONE — both columns, always.
 *
 * The cases below used to set `syncBlockedReason` alone: a row no writer can create, since all
 * five set and clear both columns in one statement. Harmless while the shell gated on the reason;
 * fictional in exactly the dimension the fix turned on. `reason` is nullable because
 * `{reason: null, since: <ts>}` is what a build older than the worker actually receives.
 */
const blockedMailbox = (reason: string | null, over: Partial<MailboxFacts> = {}): MailboxFacts =>
  mailbox({
    syncBlockedReason: reason,
    syncBlockedSince: new Date(Date.parse(ISO) - 420_000).toISOString(),
    ...over,
  });

function stage(): void {
  vi.useFakeTimers();
  // The wall clock is pinned to the fixture's own instant, so `createdAt: ISO` means "connected
  // right now" and the `awaiting` elapsed minutes are whatever the test advances.
  vi.setSystemTime(new Date(ISO));
  seq = 0;
  answer = empty;
  facts = null;
  probeFails = false;
  probeCalls = 0;
  polls = 0;
  shellCommits = 0;
  window.location.hash = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/sync")) {
      polls += 1;
      return answer();
    }
    // The consent state, answered properly rather than by the catch-all below.
    //
    // The shell partitions mail by who sent it, and it refuses to do so until the server has
    // told it the dormancy window — so a mock that answers every url with `{}` leaves the
    // partition switched off and these walks silently stop covering it. This says what the
    // fixtures are: an ONBOARDED account (the review has been answered) on the default window.
    if (String(input).includes("/consent")) {
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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return [];
    }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
}

async function unstage(): Promise<void> {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.useRealTimers();
  vi.restoreAllMocks();
}

type ShellModules = [typeof import("../app/shell/AppShell.js"), typeof import("@ohmail/ui")];
let modules: ShellModules;

/*
 * THE MODULE GRAPH, ONCE, before any case and under the stubs the first case would give it.
 * Imported inside `shell()` it landed in whichever case ran first: cold, that is the webapp's
 * graph transformed and evaluated (nearly all of that case's 4 s at load 35), and beside a build it
 * timed the first case out at 5 s with the rest of the file red behind it.
 */
beforeAll(async () => {
  stage();
  try {
    modules = await Promise.all([import("../app/shell/AppShell.js"), import("@ohmail/ui")]);
  } finally {
    await unstage();
  }
}, WALK_MS);
beforeEach(stage);
afterEach(unstage);

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const countCommit = (): void => {
  shellCommits += 1;
};

/** The shipped shell, live, wrapped in exactly what the Cloud entry wraps it in. */
async function shell(opts: { probe?: boolean; strict?: boolean } = {}): Promise<HTMLElement> {
  const [{ AppShell }, { ThemeProvider, ToastHost }] = modules;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);

  /**
   * The probe, or nothing — and `undefined` is the DESKTOP bundle's shape, which is the case
   * the desktop guard exists for. Typed rather than a `Record<string, unknown>`: this app typechecks its
   * tests, so a prop renamed on `AppShell` has to break this file rather than silently stop
   * being passed.
   */
  const probe = async (): Promise<MailboxFacts[]> => {
    probeCalls += 1;
    // The Cloud client's probe REJECTS on failure and never returns `[]` — see `CloudShell`.
    if (probeFails) throw new Error("503");
    return facts ?? [];
  };
  const props = {
    demo: false,
    resolveOwner: async () => ({ kind: "owner", accountId: "acct_live_1" }) as const,
    mailboxFacts: opts.probe === false ? undefined : probe,
  };

  await act(async () => {
    const tree = (children: React.ReactElement): React.ReactElement =>
      (opts.strict ? h(React.StrictMode, null, children) : children);
    root.render(tree(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date(ISO),
        children: h(ThemeProvider, {
          children: h(ToastHost, {
            children: h(React.Profiler, { id: "shell", onRender: countCommit }, h(AppShell, props)),
          }),
        }),
      }),
    ));
    await Promise.resolve();
  });
  await tick(0);
  return container;
}

/** Move to a view the way the product does — the hash IS the route. */
async function goTo(view: string): Promise<void> {
  await act(async () => {
    window.location.hash = `#/${view}`;
    window.dispatchEvent(new Event("hashchange"));
    await vi.advanceTimersByTimeAsync(0);
  });
}

const text = (el: HTMLElement): string => el.textContent ?? "";
const rowCount = (el: HTMLElement): number => el.querySelectorAll(".row[data-id]").length;
const bar = (el: HTMLElement): HTMLElement | null => el.querySelector(".sync-bar");

/**
 * Drive the mirror UP by `n` messages per poll for `polls` polls.
 *
 * This is the shape of the measured defect: the worker writes an import in batches and the
 * client's poll picks each one up, so the mirror climbs across many drains rather than in
 * one. `hasMore: false` on every page, because a real import is many CYCLES, not one long drain
 * — which is precisely why `bootstrapping` could not see it.
 */
async function importFor(polls: number, n = 30): Promise<void> {
  for (let i = 0; i < polls; i++) {
    answer = () => page(n);
    await tick(8_000);
  }
  answer = empty;
}

/**
 * The count the strip is currently reporting.
 *
 * `[\d,]` and a strip of separators, not `\d+`, and the reason is worth keeping: `next-intl`
 * formats a four-digit count with a group separator, and a `/(\d+) messages/` capture matched only the last group — so a rising count
 * read as 945 → 50 and the guard reported that the count had gone BACKWARDS. The assertion was
 * right and the probe was wrong, which is the cheaper of the two mistakes only if you check.
 */
function counted(s: string, where: string): number {
  const m = /([\d,]+) messages so far/.exec(s);
  expect(m, `${where}: the strip stopped saying anything at all`).not.toBeNull();
  return Number(m![1]!.replace(/,/g, ""));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE STRIP SPEAKS IN EVERY VIEW, WITH ROWS PRESENT (the historical)
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("a mailbox nobody is syncing says so wherever you are standing", () => {
  it("names the reason in Ohbox, Reads, Receipts and the Screener — with mail on screen", async () => {
    facts = [mailbox({
      syncBlockedReason: "lease_unreadable",
      syncBlockedSince: new Date(Date.parse(ISO) - 420_000).toISOString(),
      lastSyncAt: new Date(Date.parse(ISO) - 60_000).toISOString(),
    })];
    answer = () =>
      new Response(
        JSON.stringify({
          changes: {
            creates: [
              message("ohb1", "INBOX", 1), message("ohb2", "INBOX", 2),
              message("rd1", "ohmail/News", 3), message("rc1", "ohmail/Receipts", 4),
              message("sc1", "ohmail/Screener", 5),
              // The two Ohbox senders are consented; `sc1`'s deliberately is not, so the
              // Screener stays populated for the reason it exists.
              rule("ohb1@example.invalid", 6), rule("ohb2@example.invalid", 7),
            ],
            updates: [], moves: [], deletes: [],
          },
          cursor: "c1", hasMore: false, serverTime: ISO,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const c = await shell();
    await tick(0);

    // THE PREMISE, ASSERTED. Without rows this whole file could pass against an empty state,
    // which is the mistake `sync-visible.test.ts`'s header was written about.
    expect(rowCount(c), "the fixture never landed — nothing below would prove anything")
      .toBeGreaterThan(0);

    for (const view of ["ohbox", "reads", "receipts", "screener"]) {
      await goTo(view);
      expect(text(c), `${view} said nothing about a mailbox that is not being synced`)
        .toContain("ohmail cannot read its own folder");
      expect(text(c), `${view} did not name the mailbox`).toContain("desk@trafficflow.invalid");
      expect(text(c), `${view} did not say how long`).toContain("for 7 minutes");
      expect(text(c), `${view} editorialised`).not.toMatch(/try again later|contact|sorry|don't worry/i);
    }

    await goTo("ohbox");
    expect(rowCount(c), "the strip replaced the mail instead of sitting above it")
      .toBeGreaterThan(0);
  });

  it("sits above the deck, where no list can carry it off", async () => {
    facts = [mailbox({ syncBlockedReason: "at_capacity" })];
    const c = await shell();
    await tick(0);
    const b = bar(c);
    expect(b).toBeTruthy();
    // Structural, because "does not scroll away" cannot be measured in jsdom.
    expect(b!.closest(".deck"), "the strip was rendered inside the deck").toBeNull();
    expect(b!.closest(".view"), "the strip was rendered inside a view").toBeNull();
    expect(b!.parentElement!.classList.contains("shell")).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE PROGRESS STATE KEYS ON THE MIRROR, NOT ON `last_sync_at`
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the stamp is not consulted, in EITHER polarity", () => {
  /**
   * The stubs CONTRADICT each other on purpose.
   *
   * A fixture where the stamp and the mirror agree proves nothing: it passes whichever field
   * the code reads. `last_sync_at` is wrong in both directions in production — it is written for
   * every mailbox a cycle served in one `UPDATE … WHERE id IN (…)`
   * (`apps/worker/src/mailboxes.ts`), and it is pushed even when the cycle ended with
   * `hasBacklog` true (`apps/worker/src/index.ts:1281`) — so both halves below have to hold.
   */
  it("a mailbox stamped ONE SECOND AGO still reports a growing mirror", async () => {
    facts = [mailbox({ lastSyncAt: new Date(Date.parse(ISO) - 1_000).toISOString() })];
    const c = await shell();
    await importFor(3);
    expect(text(c), "a fresh stamp suppressed a growing mirror").toContain("Syncing your mail");
    expect(counted(text(c), "the mirror's count"), "the count was not the mirror's").toBe(90);
  });

  it("a mailbox stamped NEVER, over a still mirror, reports no import", async () => {
    facts = [mailbox({ lastSyncAt: null })];
    const c = await shell();
    await importFor(3);
    expect(text(c), "the premise: it was importing").toContain("Syncing your mail");
    // The import ends. `lastSyncAt` is still null — a stamp-keyed implementation would keep
    // claiming an import for ever.
    await tick(120_000);
    expect(text(c), "a null stamp kept the import on screen after the mirror settled")
      .not.toContain("Syncing your mail");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE THIRTY MINUTES, AS A TEST
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("thirty minutes of a first import is thirty minutes of a rising count", () => {
  it("keeps counting for the whole import, and never says 'Waiting for first sync'", async () => {
    facts = [mailbox({ lastSyncAt: null })];
    const c = await shell();

    const seen: number[] = [];
    // Ten minutes of 8 s polls, each landing a batch — the measured shape (27 msgs / 20 s).
    for (let minute = 0; minute < 10; minute++) {
      await importFor(7, 15);
      seen.push(counted(text(c), `minute ${minute}`));
      expect(text(c), `minute ${minute}: the dead string came back`)
        .not.toContain("Waiting for first sync");
      expect(text(c), `minute ${minute}: a percentage was invented`).not.toMatch(/%/);
      expect(text(c), `minute ${minute}: a total was implied`)
        .not.toMatch(/\bof\s+\d+\s+messages\b/);
    }

    // STRICTLY rising, at every sample. A frozen number is the same lie in a new font.
    expect(seen.length).toBe(10);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!, `the count went backwards or stalled between samples ${i - 1} and ${i}`)
        .toBeGreaterThan(seen[i - 1]!);
    }
    expect(seen[9]!).toBeGreaterThan(900);

    // THE WALK'S COST, BY COUNT, which is what lets its bound be a hang bound: 290 shell commits
    // over 73 polls (see WALK_COMMITS_MAX for what holds it there). A shell that takes an
    // extra render pass per update reds here at any load, rather than timing out only on a busy host.
    expect(shellCommits, `the walk committed the shell ${shellCommits} times over ${polls} polls`)
      .toBeLessThanOrEqual(WALK_COMMITS_MAX);
  });

  /**
   * THE NUMBER A PERSON READS, on a mirror the window has bounded.
   *
   * Measured twice on the candidate: the Windows guest and the Omarchy guest both painted
   * "<minRows> messages so far" — `DESKTOP_WINDOW.minRows` to the digit — while the engine's own
   * store held tens of thousands, because the strip was quoting the renderer's PROJECTION.
   * `pulledCount` is unit-tested in `import-numerator-windowed.test.ts`; this asserts the wiring,
   * which that file cannot: a selector returning the right number and a shell that never passes
   * it to the strip are the same screen to a person.
   *
   * WATCHED RED by reverting `AppShell`'s `mirrored` back into the ladder's `count`.
   */
  it("quotes the store's count and not the bounded mirror, in the RENDERED line", async () => {
    // The import is open (no stamp), and the local door answers a count far above anything this
    // mirror will hold — the windowed shape, with the numbers small enough to drive in jsdom.
    facts = [mailbox({ lastSyncAt: null, initialImportCompletedAt: null, messageCount: 24_000 })];
    const c = await shell();
    await importFor(4, 15);

    expect(text(c), "the premise: the strip is in its importing arm").toContain("Syncing your mail");
    const shown = counted(text(c), "the windowed mirror");
    expect(shown, "the rendered line quotes the store the import writes into").toBe(24_000);
    // And it is NOT this device's row count, which is what shipped.
    expect(shown).toBeGreaterThan(60);
    expect(text(c), "no total was implied — a local door has no denominator")
      .not.toMatch(/\bof\s+[\d,]+\s+messages\b/);
  });

  it("a first drain completing does NOT silence it — that gate was the whole defect", async () => {
    // `bootstrapping` goes false here, at the first landed drain. Under the old gate the Ohbox
    // counter switched itself off at this exact moment and the product went quiet for the rest
    // of the import.
    facts = [mailbox({ lastSyncAt: null })];
    const c = await shell();
    await importFor(2);
    expect(text(c), "the premise: something is being said").toContain("Syncing your mail");
    await importFor(20);
    expect(text(c), "the product went quiet once this tab's first drain had landed")
      .toContain("Syncing your mail");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   AND IT MUST NOT FLASH ON ORDINARY MAIL
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("a busy morning is not an import", () => {
  it("stays silent while single messages arrive on a settled mailbox", async () => {
    facts = [mailbox({ lastSyncAt: new Date(Date.parse(ISO) - 60_000).toISOString() })];
    const c = await shell();

    // Build a mature mirror first, then let it settle — the strip's own state must go quiet.
    await importFor(17, 30);
    await tick(120_000);
    expect(rowCount(c), "the premise: this mailbox has mail in it").toBeGreaterThan(0);
    expect(bar(c), "the strip did not go quiet after the import finished").toBeNull();

    // Now ordinary post: one message, then two in adjacent polls.
    answer = () => page(1);
    await tick(8_000);
    answer = () => page(2);
    await tick(8_000);
    answer = empty;
    expect(bar(c), "the strip flashed on three ordinary messages").toBeNull();
    expect(text(c)).not.toContain("Syncing your mail");
  });

  /* ONE BURST IS ONE RISE, under StrictMode too. The growth fold runs in render (see
     WALK_COMMITS_MAX), and a double render folding one arrival twice reads two rises and speaks
     over a settled mailbox. A second burst inside the growth window does speak: the fold runs. */
  it("under StrictMode one burst stays silent, and a second burst speaks", async () => {
    facts = [mailbox({ lastSyncAt: new Date(Date.parse(ISO) - 60_000).toISOString() })];
    const c = await shell({ strict: true });
    await importFor(17, 30);
    await tick(120_000);
    expect(bar(c), "the premise: the strip went quiet after the import").toBeNull();

    answer = () => page(30);
    await tick(8_000);
    answer = empty;
    expect(text(c), "one burst was folded as two rises").not.toContain("Syncing your mail");

    answer = () => page(30);
    await tick(8_000);
    answer = empty;
    expect(text(c), "two bursts inside the growth window did not speak").toContain("Syncing your mail");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ONE QUIET POLL IS NOT A STALL
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("a batch gap must not flip the sentence", () => {
  it("survives a poll that lands nothing, and never falls back to 'awaiting'", async () => {
    facts = [mailbox({ lastSyncAt: null })];
    const c = await shell();
    await importFor(10, 30);
    expect(text(c)).toContain("Syncing your mail");

    // One empty poll, exactly the gap between two worker batches.
    answer = empty;
    await tick(8_000);
    expect(text(c), "one quiet poll was reported as a stalled import")
      .toContain("Syncing your mail");
    expect(text(c), "…or worse, as nothing having arrived at all")
      .not.toContain("Waiting for the first mail");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   "IT COMES UP AND DISAPPEARS CONSTANTLY"

   Reported 2026-08-04 while watching a live import. The case above proves that ONE quiet poll does not flip
   the sentence; these prove it for the gaps that are actually there — a worker cycle, the
   measured trace's quiet gaps mid-import and its idle between drains, none of
   which one run window can span.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("three worker drains are ONE appearance of the strip", () => {
  it("never goes silent across 45 s idle and 31 s quiet gaps", async () => {
    facts = [mailbox({ lastSyncAt: null })];
    const c = await shell();

    let appeared = false;
    const vanished: string[] = [];
    const look = (where: string): void => {
      if (text(c).includes("Syncing your mail")) appeared = true;
      else if (appeared) vanished.push(where);
    };

    for (let drain = 0; drain < 3; drain++) {
      for (let poll = 0; poll < 4; poll++) {
        answer = () => page(30);
        await tick(8_000);
        look(`drain ${drain}, poll ${poll}`);
      }
      // The quiet gap measured INSIDE one import — one second past the run window.
      answer = empty;
      await tick(31_000);
      look(`drain ${drain}, the 31 s quiet gap`);
      // …and the rest of the 45 s between two worker cycles.
      await tick(14_000);
      look(`drain ${drain}, 45 s idle`);
    }

    expect(appeared, "the strip never appeared — the trace is wrong, not the code").toBe(true);
    expect(vanished, "the strip disappeared mid-import here").toEqual([]);
    expect(counted(text(c), "after three drains"), "the premise: a real import").toBe(360);

    // …and it does still end. A latch that never releases is permanent chrome, which is the
    // failure `SyncBar.tsx` was built to avoid.
    await tick(120_000);
    expect(bar(c), "the strip never stood down after the import finished").toBeNull();
  });

  it("a backfill moving mail OUT of the mirror does not retract the import", async () => {
    /**
     * the first defect at the rendered seam. The qualifier was `count - runStartCount`, a NET
     * delta, so messages leaving the mirror subtracted from the evidence that an import was
     * running — and a Screener backfill moves a great many.
     *
     * The first import has to be allowed to FINISH first, or this proves nothing: a run that
     * starts from an empty mirror qualifies on its own and would carry the second episode
     * regardless of how the delta is measured.
     */
    facts = [mailbox({ lastSyncAt: null })];
    const c = await shell();
    await importFor(3, 30);
    expect(text(c), "the premise: the first import ran").toContain("Syncing your mail");
    await tick(120_000);
    expect(bar(c), "the premise: and finished, so nothing is latched").toBeNull();

    // Now the backfill, inside ONE run window: +15, then 20 moved out, then +15. Thirty arrived;
    // the net delta is ten, which is under IMPORT_MIN_DELTA.
    answer = () => page(15);
    await tick(8_000);
    answer = () => removing(Array.from({ length: 20 }, (_, i) => `m${i + 1}`));
    await tick(8_000);
    // Nothing is asserted about the strip HERE on purpose: one rise is not an import and the
    // strip is correctly silent. The fall is proven by the final count instead.
    answer = () => page(15);
    await tick(8_000);
    answer = empty;

    expect(text(c), "a delete retracted an import that was genuinely running")
      .toContain("Syncing your mail");
    // 90 + 15 − 20 + 15. If the deletes had not applied this would read 120, so this number is
    // also the premise: the mirror really did fall in the middle of the run.
    expect(counted(text(c), "after the backfill")).toBe(100);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   NO PROBE, AND A FAILED PROBE, ARE NOT AN EMPTY ACCOUNT
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the shell says nothing it cannot know", () => {
  it("with no probe at all (the Desktop bundle's shape) it never claims a mailbox state", async () => {
    const c = await shell({ probe: false });
    await importFor(5);
    await tick(600_000);
    expect(probeCalls).toBe(0);
    for (const claim of ["No mailbox connected", "Not syncing", "Waiting for the first mail", messages.sync.failing]) {
      expect(text(c), `a shell with no probe claimed "${claim}"`).not.toContain(claim);
    }
  });

  it("A PROBE THAT FAILS IS NOT AN EMPTY ACCOUNT — a 503 must not read as 'no mailbox'", async () => {
    probeFails = true;
    const c = await shell();
    await tick(120_000);
    expect(probeCalls, "the probe was never called — this test proves nothing").toBeGreaterThan(0);
    expect(text(c), "a failed read was rendered as a fact about the account")
      .not.toContain("No mailbox connected");
  });

  it("…but a probe that ANSWERS zero does say so, and points somewhere", async () => {
    facts = [];
    const c = await shell();
    await tick(0);
    expect(text(c)).toContain("No mailbox connected");
    expect(c.querySelector<HTMLAnchorElement>(".sync-bar a")!.getAttribute("href"))
      .toBe("#/settings/mailboxes");
  });

  it("and a mailbox that was seen is not un-seen by a later failure", async () => {
    facts = [blockedMailbox("awaiting_credentials")];
    const c = await shell();
    await tick(0);
    expect(text(c)).toContain("no mailbox password is stored");
    probeFails = true;
    await tick(120_000);
    expect(text(c), "the last thing we actually knew was thrown away on one failed read")
      .toContain("no mailbox password is stored");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   the UI HALF: `connected`, no errorCode, and still not syncing
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("mail 0029 becomes visible", () => {
  it("a CONNECTED mailbox with no errorCode still reports why it is not syncing", async () => {
    // The row's shape in production: `status='connected'`, all four `error*` columns null. That
    // asymmetry is mail 0029's entire design, and gating this read on `status === 'error'` is
    // the anti-fix the DTO comment warns about — it restores the 32-minute silence.
    for (const [reason, phrase] of [
      ["lease_unreadable", "cannot read its own folder"],
      ["awaiting_credentials", "no mailbox password is stored"],
      ["at_capacity", "This one is on us"],
      // mail 0105. The one member whose sentence names something the PERSON can do, so a raw key
      // path here is worse than for its neighbours: the reason exists to replace
      // `lease_unreadable`'s "ohmail cannot read its own folder", which is false for this cause
      // and names nothing actionable.
      ["clock_off", "clock is too far from the mail server's"],
      // mail 0130 — the server's own "not now": a throttle or UNAVAILABLE/LIMIT, which used to
      // arrive as the mailbox-error sentence over a mailbox that was never broken.
      ["provider_unavailable", "the mail server asked ohmail to wait"],
      // mail 0142 — a full `ohmail/_meta`, whose cure is in the person's mailbox: MOVE, never remove.
      ["meta_folder_full", "Move mail that was filed into it to another folder"],
      // mail 0143 — a `_meta` that takes no delete: the cure is a PERMISSION, never a deletion.
      ["meta_undeletable", "Give that folder delete permission"],
      // mail 0185 — the mailbox at its own quota at the provider refused the claim for room.
      ["mailbox_full", "is full"],
    ] as const) {
      facts = [blockedMailbox(reason, { status: "connected", errorCode: null })];
      const c = await shell();
      await tick(0);
      expect(text(c), `${reason} rendered nothing`).toContain(phrase);
      expect(text(c), `${reason} rendered a raw key path`).not.toContain(`blocked_${reason}`);
      // It is a condition, not an event: polite, never an alert.
      expect(bar(c)!.getAttribute("role")).toBe("status");
    }
  });

  it("a reason from a newer server gets a sentence rather than silence", async () => {
    facts = [blockedMailbox("a_fourth_reason")];
    const c = await shell();
    await tick(0);
    expect(text(c), "an unrecognised reason was answered with silence")
      .toContain("Not syncing this mailbox");
    expect(text(c)).not.toContain("blocked_a_fourth_reason");
  });

  it("a block the SERVER narrowed away still reaches the strip", async () => {
    /**
     * THE SHAPE THE WIRE ACTUALLY SENDS UNDER SKEW, and the one the strip used to miss.
     *
     * The case above feeds `a_fourth_reason` as if the client received the raw token. It cannot:
     * `mailbox-service.ts:526` narrows the reason to THIS BUILD's copy of the closed set before it
     * leaves the server, and forwards `syncBlockedSince` on the next line untouched. So what a
     * client older than the worker receives is `{reason: null, since: <ts>}` — and under the old
     * `syncBlockedReason !== null` gate that was silence, with the strip saying "Synced moments
     * ago" about a mailbox nobody was organizing.
     *
     * MUTATION: revert `mail-state.ts`'s gate to the reason → this goes red and the case above
     * stays green, which is the whole reason both exist.
     */
    facts = [blockedMailbox(null)];
    const c = await shell();
    await tick(0);
    expect(text(c), "a block with no nameable reason was answered with silence")
      .toContain("Not syncing this mailbox");
    expect(bar(c)!.getAttribute("role")).toBe("status");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ONE DERIVATION: the pane finishes it, and never overrules it
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("an empty Ohbox that is CORRECT says so, and only then", () => {
  it("points at the Screener when every sender so far is a first contact", async () => {
    facts = [mailbox({ lastSyncAt: new Date(Date.parse(ISO) - 60_000).toISOString() })];
    answer = () => page(4, "ohmail/Screener");
    const c = await shell();
    await tick(0);
    answer = empty;
    await tick(120_000);

    // THE PRECONDITION, ASSERTED: mail exists and none of it is in the Ohbox. An empty-mailbox
    // test that passes because there was never any mail is vacuous.
    await goTo("ohbox");
    expect(text(c), "the mirror never received the fixture").toContain("Screener");
    expect(rowCount(c), "the Ohbox has rows — this is not the state under test").toBe(0);
    expect(text(c)).toContain("Nothing in your Ohbox yet");
    expect(text(c)).toContain("waiting in the Screener");
    expect(text(c), "the pane editorialised").not.toMatch(/sorry|don't worry|oops/i);
  });

  it("stands down with MAIL IN THE MIRROR when the ladder is reporting an impediment", async () => {
    /**
     * THE ARM THAT MAKES THIS GUARD BITE, and it was missing.
     *
     * The first two arms of that change both had `state.count === 0` at the moment of assertion, so
     * mutating the pane's condition from `!state.screenerCandidate` to `state.count === 0`
     * changed no behaviour and the mutation stayed GREEN. A guard nobody has watched fail is
     * not evidence, so here is the fixture that separates them: mail HAS landed (count > 0),
     * the Ohbox is empty, and the mailbox is blocked — so the ladder carries a count and
     * refuses the Screener explanation, because a mailbox nothing is syncing may simply not
     * have delivered the rest yet.
     */
    facts = [blockedMailbox("lease_unreadable", {
      lastSyncAt: new Date(Date.parse(ISO) - 60_000).toISOString(),
    })];
    answer = () => page(4, "ohmail/Screener");
    const c = await shell();
    await tick(0);
    answer = empty;
    await tick(120_000);

    await goTo("ohbox");
    expect(text(c), "the premise: the strip is reporting the block").toContain("cannot read its own folder");
    expect(rowCount(c), "the premise: the Ohbox is empty").toBe(0);
    expect(text(c), "the pane explained where the mail went while the mailbox was not being synced")
      .not.toContain("Nothing in your Ohbox yet");
  });

  it("and the pane STANDS DOWN when the strip has something more important to say", async () => {
    // Same fixture; now the loop is failing. The count is frozen, so an explanation of where
    // the mail went would be a claim about a mirror that cannot move.
    facts = [mailbox({ lastSyncAt: new Date(Date.parse(ISO) - 60_000).toISOString() })];
    answer = () => page(4, "ohmail/Screener");
    const c = await shell();
    await tick(0);
    answer = () => new Response("{}", { status: 503 });
    await tick(30_000);

    await goTo("ohbox");
    expect(text(c), "the premise: the strip is reporting the outage").toContain(messages.sync.failing);
    expect(text(c), "the pane re-derived its own state and overruled the ladder")
      .not.toContain("Nothing in your Ohbox yet");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   "WAITING" IS ALLOWED, BUT NOT AS FOUR WORDS THAT NEVER CHANGE
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("an honest wait", () => {
  it("says how long, and a six-minute first import is NOT called slow", async () => {
    // Measured: `mailbox_attach_started → mailbox_attached` took minutes, twice, for a
    // modest mailbox. Six minutes of an empty mirror is normal and must not be dressed
    // as a fault — that is the opposite defect to the silent first import, and just as false.
    facts = [mailbox({ lastSyncAt: null, createdAt: ISO })];
    const c = await shell();
    await tick(0);
    expect(text(c)).toContain("The first sync has not finished yet");

    await tick(240_000);
    expect(text(c), "the wait did not say how long").toContain("connected 4 minutes ago");
    expect(text(c), "a healthy 4-minute wait was escalated").not.toContain("still has not finished");

    await tick(120_000);
    expect(text(c)).toContain("connected 6 minutes ago");
    expect(text(c), "a measured-normal 6-minute first import was called slow")
      .not.toContain("still has not finished");
  });

  it("escalates past ten minutes, offers the one action, and never claims a failure", async () => {
    facts = [mailbox({ lastSyncAt: null, createdAt: ISO })];
    const c = await shell();
    await tick(660_000);
    expect(text(c)).toContain("The first sync still has not finished");
    expect(text(c)).toContain("connected 11 minutes ago");
    expect(c.querySelector<HTMLAnchorElement>(".sync-bar a")!.getAttribute("href"))
      .toBe("#/settings/mailboxes");
    expect(text(c), "an unfinished first sync was reported as an error")
      .not.toMatch(/failed|error|broken/i);
  });

  it("and the moment mail lands it stops waiting — the reported string is unreachable", async () => {
    facts = [mailbox({ lastSyncAt: null, createdAt: ISO })];
    const c = await shell();
    await tick(0);
    expect(text(c)).toContain("The first sync has not finished");
    await importFor(3);
    expect(text(c), "it kept waiting while the mirror grew — the exact defect")
      .not.toContain("The first sync has not finished");
    expect(text(c)).toContain("Syncing your mail");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE CLIMBING COUNT MUST NOT BE ANNOUNCED SEVEN TIMES A MINUTE
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the count is readable, and not shouted", () => {
  it("keeps the volatile half out of the live region without hiding it", async () => {
    facts = [mailbox({ lastSyncAt: null })];
    const c = await shell();
    await importFor(3);

    const b = bar(c)!;
    expect(b.getAttribute("role")).toBe("status");
    expect(b.getAttribute("aria-live")).toBe("polite");
    const num = b.querySelector(".num")!;
    // `aria-live="off"` and NOT `aria-hidden`: a number that changes every eight seconds must
    // not be re-announced, but it is the information — removing it from the accessibility tree
    // would be a second defect dressed as a fix for the first.
    expect(num.getAttribute("aria-live"), "the climbing count is inside a polite live region")
      .toBe("off");
    expect(num.getAttribute("aria-hidden"), "the count was hidden from assistive tech entirely")
      .toBeNull();
    expect(counted(num.textContent ?? "", "the number")).toBe(90);
    // The stable half carries the sentence, so it announces once when the strip appears.
    expect(b.querySelector("b")!.textContent).toBe("Syncing your mail.");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   A WARM MIRROR LOADING IS NOT A FIRST IMPORT

   The reported defect: "Syncing your mail. N messages so far" over a mailbox whose import
   finished long ago. The live engine is built with an EMPTY in-memory mirror and the shell
   renders before the device's copy is read out of IndexedDB, so the growth sampler seeded at 0.
   Hydration then arrived as ONE jump from 0 to the whole persisted count — read as the first rise
   of a first import (`runStartCount === 0`) — and one ordinary message within the window latched
   the episode. The count shown was the size of the whole mirror, not import progress.

   The existing G-tests cannot see this: their `shell()` drains an EMPTY first page, so the mirror
   is 0 at the end of bootstrap and every import they drive starts from a genuinely empty mirror
   AFTER the first drain. This one lands the persisted count DURING the first drain — the shape
   hydration has — and keeps `initialImportCompletedAt` non-null so the import FLOOR cannot mask
   the growth reading that is actually under test.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("the mirror being read is not the mirror growing", () => {
  it("stays quiet on a warm load, and ordinary mail after it does not latch a false import", async () => {
    // A FINISHED import (the default), so nothing below can be the FLOOR speaking — only growth.
    facts = [mailbox({ initialImportCompletedAt: ISO })];
    // The persisted mailbox, delivered as the FIRST drain: the shape IndexedDB hydration has —
    // one jump from 0 to the whole count, while `bootstrapping` is still true. Thirty clears
    // IMPORT_MIN_DELTA, so a reading that counts the jump as growth cannot be excused as too
    // small to matter — which is why "don't bypass min-delta" alone would not fix this.
    answer = () => page(30);
    const c = await shell();
    answer = empty;
    await tick(0);

    // Premise: the warm mirror really did land, and it is not being announced the moment it loads.
    expect(rowCount(c), "the warm mirror never landed — nothing below proves anything")
      .toBeGreaterThan(0);
    expect(bar(c), "a warm mirror was announced as an import the moment it loaded").toBeNull();

    // Two ordinary messages in adjacent polls — the "one more message within 30 s" that latched it.
    answer = () => page(1);
    await tick(8_000);
    answer = () => page(1);
    await tick(8_000);
    answer = empty;

    expect(bar(c), "a settled mailbox plus ordinary mail latched a false import")
      .toBeNull();
    expect(text(c), "the false 'Syncing your mail' sentence reached the screen")
      .not.toContain("Syncing your mail");
  });
});
