/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv,
  tick,
} from "./fixtures/live-walk-shell";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";

/**
 * THE SCREENER IS THE CONSENT CUTLINE'S OWN SURFACE, AND IT WAS THE ONE THAT IGNORED IT.
 *
 * `consentPartition` decides where every message is PRESENTED, and `presentationReader` hands the
 * pile selectors a mirror in which grouping by folder IS grouping by place. Ohbox, Reads,
 * Receipts, the triage piles, Tags and History were all built from that projected reader. The
 * Screener queue was built from `engine.read()` — the raw mirror — so it grouped by the folder
 * the mail server happens to hold the message in and the cutline never reached it.
 *
 * ── WHY THAT IS WORSE THAN A COSMETIC MISCOUNT ────────────────────────────────────────────
 *
 * Measured on a large real mailbox whose backfill had already filed most of its messages into
 * `ohmail/Screener`: the queue offered **far more sender rows than anyone could screen**, most of them senders who
 * went quiet years ago and whose mail was simultaneously being presented in History. The cutline
 * put the real queue at **a small fraction of that**. Three distinct wrongs, one cause:
 *
 *   1. a DORMANT undecided sender is a Screener row AND a History row at once — the double
 *      presentation the cutline exists to prevent;
 *   2. a CONSENTED sender's backlog still sitting in the Screener folder is a Screener row even
 *      though it presents in the Ohbox, so the product asks for a decision it already has;
 *   3. the rail badge and the header count are that same raw number, so the one number telling
 *      somebody how much screening they owe was off by most of itself.
 *
 * ── THE ONE THE OBVIOUS FIX INTRODUCED, AND HOW #116 CLOSED IT ─────────────────────────────
 *
 * Projecting the reader also pulls an active undecided sender's INBOX mail into the waiting
 * bucket, because the partition presents it in the Screener. The grouping is right to include it;
 * the ROW ID may not name it for a decide. `POST /screener/:id` resolves only messages whose
 * `desired_folder` is `ohmail/Screener`, and `derivedScreenerEffects` refuses locally on the same
 * condition — so a DECIDE on an INBOX representative renders every control and performs none of
 * them. The first cut suppressed such rows entirely, which was the #116 vanish: a bulk-moved
 * undecided+active sender (its mail all in the INBOX, presented at the gate) had no row anywhere
 * but search, and re-screening it silently did nothing.
 *
 * So the row IS minted — on the newest GATE-PHYSICAL message when the sender has one (the mixed
 * case below pins that id), else on `newestFirst[0]`, marked `gatePhysical:false`. That flag routes
 * the commit PAST THE GATE as a `rule_create` (destination INBOX for a screen-in) with `applyRetro`
 * rather than a dead decide, so the control performs and the sender's bag lands in the Ohbox.
 *
 * ── WHY THE FIXTURE PUTS MAIL IN `ohmail/Screener` AND NOT THE INBOX ──────────────────────
 *
 * `history-view.test.ts` seeds everything in the INBOX, which is why it never caught this: with
 * no message physically in the Screener folder, `screenerSegments` over the raw mirror yields an
 * empty queue and agrees with the projected one by accident. The defect is only visible on a
 * mailbox whose mail has ALREADY been filed into the Screener — which is every mailbox that has
 * been through a backfill, i.e. the normal case rather than an edge one.
 *
 * One message per sender except where the point IS two, and every date distinct: a row's id is its
 * sender's newest gate-physical message, and a tie would make these assertions depend on
 * `byDateDesc`'s id tiebreak rather than on the rule under test.
 */

/** ISO is 2026-08-04 and the window is 60 days, so this is comfortably dormant. */
const LONG_AGO = "2024-01-11T09:00:00.000Z";
/** Inside the window: its sender is active on recency alone, with nothing unread. */
const RECENT = "2026-07-28T09:00:00.000Z";

const SCREENER = "ohmail/Screener";

const message = (o: {
  id: string; from: string; folder?: string; unread?: boolean; date?: string;
}, seq: number) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: o.date ?? LONG_AGO, folder: o.folder ?? SCREENER,
    snippet: `snippet of ${o.id}`, unread: o.unread ?? false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  },
});

const rule = (address: string, seq: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
  },
});

const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          // DORMANT + undecided + read, in the Screener folder ⇒ History, and NOT a queue row.
          message({ id: "dorm1", from: "quiet@example.invalid" }, 1),
          // Undecided but UNREAD ⇒ active whatever its age ⇒ a real queue row.
          message({ id: "loud1", from: "loud@example.invalid", unread: true }, 2),
          // Undecided, read, but INSIDE the window ⇒ active on recency ⇒ a real queue row.
          message({ id: "fresh1", from: "fresh@example.invalid", date: RECENT }, 3),
          // CONSENTED AND RETIRED ⇒ since ARCH-R902 at the gate where it sits (its rule moved
          // nothing) and still not asked about: a decision is standing, and the server's own
          // queue retires this sender by the same cutline.
          message({ id: "known1", from: "friend@example.invalid" }, 4),
          rule("friend@example.invalid", 5),
          // CONSENTED AND STILL HELD ⇒ a rule exists, the mail is ACTIVE and physically at the
          // gate, and the mail server is still holding it. `GET /screener` consults no rules, so
          // it asks about this sender; a client that projected the mail to the rule's destination
          // answered a narrower question and showed the answer as the mailbox's own.
          message({ id: "ruled1", from: "ruled@example.invalid", date: RECENT }, 9),
          rule("ruled@example.invalid", 10),
          // ACTIVE + undecided and ONLY in the INBOX. The partition presents it in the Screener,
          // but the gate can resolve no id for this sender, so there is no row it could offer that
          // would work. Reachable by search only — the known gap named in `screenerSegments`.
          message({ id: "stray1", from: "stranger@example.invalid", folder: "INBOX", unread: true }, 6),
          // MIXED RESIDENCE, and the reason this fixture has two messages for one sender: the
          // NEWER one is in the INBOX and the older is at the gate. The row must exist and its id
          // must be the gate-physical `mix-gate`, because `mix-inbox` is a 404 on the wire and a
          // silent no-op locally.
          message({ id: "mix-gate", from: "mixed@example.invalid", date: "2026-07-20T09:00:00.000Z" }, 7),
          message({ id: "mix-inbox", from: "mixed@example.invalid", folder: "INBOX", unread: true, date: "2026-07-30T09:00:00.000Z" }, 8),
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c1", hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const rowIds = (c: HTMLElement): string[] =>
  within(c).queryAllByRole("option").map((row) => row.getAttribute("data-id") ?? "");

describe("the Screener queue is partitioned by consent, not by folder", () => {
  beforeEach(() => {
    installShellEnv();
    answerSyncWith(world);
  });
  afterEach(async () => {
    await teardownShellEnv();
    resetStorageOwnerForTest();
  });

  it("holds the ACTIVE undecided senders, and only those", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    const ids = rowIds(c);
    // Unread, however old.
    expect(ids).toContain("loud1");
    // Read but inside the window.
    expect(ids).toContain("fresh1");

    // Dormant ⇒ History's business, and asking about it is the backlog that never empties.
    expect(ids).not.toContain("dorm1");
    // Already consented ⇒ the decision exists; asking again is asking twice.
    expect(ids).not.toContain("known1");
  });

  /**
   * THE ROW ID IS THE THING THE GATE RESOLVES, so it has to be gate-physical.
   *
   * Mutation watched: dropping the `physicalFolder` filter on the waiting rep makes this fail with
   * `mix-inbox` — a row that renders every control and performs none of them.
   */
  it("a mixed-residence sender's row is its GATE mail, never its newer INBOX mail", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    const ids = rowIds(c);
    expect(ids).toContain("mix-gate");
    // `mix-inbox` is newer and its sender is the same person, so a naive "newest wins" picks it.
    // `POST /screener/mix-inbox` is a 404 and `screener_decide` on it yields no effects.
    expect(ids).not.toContain("mix-inbox");
  });

  it("OFFERS a row for a sender the gate holds nothing for — routed past the gate (#116)", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    // `stranger@` is active and undecided with mail only in the INBOX, presented at the gate. The
    // first cut SUPPRESSED this row — the #116 vanish, a sender reachable only by search. Now the
    // row exists (id `stray1`, its only message) and its decision is routed past the gate as a
    // rule rather than a decide that would 404. Restore the `?? newestFirst[0]` suppression and
    // this goes red.
    expect(rowIds(c)).toContain("stray1");
  });

  it("counts what it holds — the badge is the queue, not the folder", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    // loud@, fresh@, mixed@, ruled@ (a rule that has not moved the mail) and — since #116 —
    // stranger@, whose INBOX mail presents at the gate and is now decidable past it. SIX messages
    // sit in the Screener FOLDER and eight in the two undecided residences; the number a person is
    // shown must be the one they can act on. dorm@ (History) and friend@ (consented AND retired,
    // at the gate since ARCH-R902) are still excluded.
    const sections = within(within(c).getByRole("group", { name: "Screener sections" }));
    const waiting = sections.getByRole("button", { name: "Waiting 5", pressed: true });
    expect(waiting.getAttribute("title")).toContain("5 first-time senders waiting");
    expect(waiting.getAttribute("title")).not.toContain("6 first-time senders waiting");
  });

  it("a dormant sender is in History and NOWHERE ELSE — no double presentation", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);

    await goTo("history");
    expect(rowIds(c)).toContain("dorm1");

    await goTo("screener");
    expect(rowIds(c)).not.toContain("dorm1");
  });

  it("a consented sender's RETIRED Screener-folder backlog stays at the gate, not in the Ohbox", async () => {
    // INVERTED by ARCH-R902: this pinned the zero-server-moves Ohbox presentation;
    // the letter is at the gate where it sits, and the decided sender is still not asked about.
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);

    await goTo("ohbox");
    expect(rowIds(c)).not.toContain("known1");

    await goTo("screener");
    expect(rowIds(c)).not.toContain("known1");
  });

  /**
   * THE BROWSER ANSWERED FOUR WHERE THE MAILBOX HELD NINE.
   *
   * Seen on a live account: nine senders physically in `ohmail/Screener`, five of them
   * carrying an enabled rule to a consenting destination written weeks BEFORE their mail arrived.
   * `GET /screener` derives its queue from held mail and consults no rules, so it asked about all
   * nine; `consentPartition` re-homed the ruled five to their destinations and `screenerSegments`
   * grouped them out of the queue, so the shelf said four and the badge said four. A person was
   * shown "nothing waiting from these five" about mail the mail server was still holding for
   * exactly that decision. The desktop renders this shell, so it answered four too.
   */
  it("a RULED sender whose mail is still HELD is on the shelf — the rule never moved it", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    expect(rowIds(c)).toContain("ruled1");

    // One list, not two: the mail is at the gate, so the Ohbox is not also showing it as filed.
    await goTo("ohbox");
    expect(rowIds(c)).not.toContain("ruled1");
  });

  /**
   * THE OTHER DIRECTION: WHERE A SERVER EXISTS, ITS SILENCE IS STILL A REFUSAL TO PARTITION.
   *
   * The standalone tier now engages the cutline without waiting for `GET /consent`, because on a
   * build with no Cloud there is no stored window to wait for — `desktop-cutline.test.ts` is that
   * guard. This is the boundary of it. A browser tab has an API base, so it HAS a server holding
   * a window, and `consent.known` false means "that number has not arrived": the account may be
   * on a window of its own, and partitioning on the product default would move somebody's mail
   * into History on the strength of a guess. Unpartitioned shows MORE, never less, which is the
   * only safe direction for a failed request.
   *
   * Widening the new condition — reading it off anything other than "this build has no consent
   * surface" — lands here as `dorm1` disappearing out of the Screener on a tab whose `/consent`
   * merely failed.
   */
  it("a tab whose /consent never answers partitions NOTHING", async () => {
    // An account this browser holds no answer for. The cases above were answered for the account the
    // harness hands where a test names none, and a remembered answer is a known window, not a silence.
    setStorageOwner("acct_never_answered");
    // The fixture answers `/consent` properly on purpose (see `installShellEnv`); this replaces
    // that one answer with a failure and leaves `/sync` alone.
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/consent")) return new Response("{}", { status: 503 });
      return inner(input as RequestInfo, init);
    }) as typeof globalThis.fetch;

    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("screener");

    const ids = rowIds(c);
    // Unpartitioned is the pre-consent product: every message in the pile its FOLDER names. So
    // the dormant sender and the consented one are both queue rows again…
    expect(ids).toContain("dorm1");
    expect(ids).toContain("known1");
    // …and the INBOX-only sender has no row, because nothing presented them at the gate.
    expect(ids).not.toContain("stray1");

    await goTo("history");
    await tick(0);
    // History is every message the store holds (ARCHIVE-024), partitioned or not.
    expect(rowIds(c)).toContain("dorm1");
  });
});
