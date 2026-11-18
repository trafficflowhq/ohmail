/** @vitest-environment jsdom */
import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine,
  type SyncChange,
} from "@ohmail/client-engine";
import {
  ISO, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";

/**
 * THE DESKTOP NEVER ENGAGED THE CUTLINE, AND THE GATE THAT STOPPED IT WAS ABOUT SOMETHING ELSE.
 *
 * `AppShell` refuses to partition until `consent.known` is true, and the reason it gives is
 * about a STORED window it has not read yet: *"partitioning on a guessed window would move mail
 * out of the piles and into History on the strength of a default the account may not be using,
 * and a request that simply failed would silently hide somebody's mail."* Both halves of that
 * presuppose a server holding a number.
 *
 * A standalone install has no server and no stored number. `apiConfigured()` is false, so
 * `useConsentState` never issues its fetch, so `known` is false for the life of the process —
 * and the shell read that as "the answer has not arrived yet" and switched the whole cutline off.
 * The consequences are not a miscount:
 *
 *   · **NO HISTORY PILE AT ALL.** History's contents come from `consentView.history`, and there
 *     was no `consentView`. Every sender who went quiet years ago sat in the Screener queue
 *     instead, for ever — the long-queue shape `screener-cutline.test.ts` measured on the
 *     web, with nothing to correct it.
 *   · **A CONSENTED SENDER WAS ASKED ABOUT AGAIN**, because the queue grouped by the folder the
 *     mail server holds their backlog in rather than by the decision on record.
 *   · **#116's PAST-THE-GATE BRANCH WAS INERT.** It fires on a row the projection marked
 *     `gatePhysical:false`, and nothing was projected, so a sender whose mail is only in the
 *     INBOX had no row anywhere but search.
 *
 * The fix is one condition: a build with no consent surface engages the cutline on
 * `DEFAULT_DORMANCY_DAYS`, which is not a default standing in for the truth there — it is the
 * only window that build has, and the one the engine uses unasked.
 *
 * ── WHY THIS FILE CLEARS `NEXT_PUBLIC_API_BASE` ───────────────────────────────────────────
 *
 * That variable IS the signal. `api-client.ts` reads it once at module load into `API_BASE`, and
 * `apiConfigured()` is the shared shell's one way to ask "is there a server behind this build" —
 * the same question `AutoOptInControl.supported` and the drafter's `unavailable` branch ask. On
 * the desktop the whole module is replaced by `apps/desktop/src/no-api-client.ts`, whose
 * `apiConfigured` answers `false` outright. Clearing the variable reproduces that answer through
 * the real module, which is the closest a jsdom mount gets to the shipped bundle.
 *
 * The engine is handed in for the same reason the desktop hands one in: with no API base
 * `createEngine` THROWS rather than fall back to fixtures, so there is no such thing as a live
 * browser tab in this state. Which is also why the web path cannot reach the new condition —
 * `screener-cutline.test.ts` holds the other direction.
 */

/** ISO is 2026-08-04 and the window is 60 days, so this is comfortably dormant. */
const LONG_AGO = "2024-01-11T09:00:00.000Z";
/** Inside the window: its sender is active on recency alone, with nothing unread. */
const RECENT = "2026-07-28T09:00:00.000Z";

const SCREENER = "ohmail/Screener";

let seq = 0;

const message = (o: {
  id: string; from: string; folder?: string; unread?: boolean; date?: string;
}): EngineMessage => ({
  id: o.id, accountId: "acct_local_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `subject of ${o.id}`,
  from: { name: `Sender ${o.id}`, address: o.from },
  to: [], cc: [], date: o.date ?? LONG_AGO, folder: (o.folder ?? SCREENER) as Folder,
  snippet: `snippet of ${o.id}`, unread: o.unread ?? false,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
});

const rule = (address: string): RuleDTO => ({
  id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
  provenance: "seeded-from-sent", enabled: true,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
} as unknown as RuleDTO);

/**
 * The world, in the mirror rather than over a wire — which is what a standalone install's mirror
 * IS: the mail itself, served by a process on the same machine, not a cache in front of a server.
 *
 * Deliberately the same five cases `screener-cutline.test.ts` puts on the web, so a difference
 * between the two tiers is a difference in the shell and not in the fixture.
 */
async function localEngine(): Promise<OhmailEngine> {
  const rows: EngineMessage[] = [
    // DORMANT + undecided + read, in the Screener folder ⇒ History, and NOT a queue row.
    message({ id: "dorm1", from: "quiet@example.invalid" }),
    // Undecided but UNREAD ⇒ active whatever its age ⇒ a real queue row.
    message({ id: "loud1", from: "loud@example.invalid", unread: true }),
    // Undecided, read, but INSIDE the window ⇒ active on recency ⇒ a real queue row.
    message({ id: "fresh1", from: "fresh@example.invalid", date: RECENT }),
    // CONSENTED AND RETIRED ⇒ presents in the Ohbox from the Screener folder, with nothing moved.
    message({ id: "known1", from: "friend@example.invalid" }),
    // CONSENTED AND STILL HELD ⇒ the rule exists and the mail is ACTIVE and at the gate. On this
    // tier there is no `GET /screener` to ask, so the partition IS the answer: it must hold the
    // sender at the gate the install's own mail server is holding them at.
    message({ id: "ruled1", from: "ruled@example.invalid", date: RECENT }),
    // ACTIVE + undecided and ONLY in the INBOX. The cutline presents it at the gate and #116
    // mints its row on an INBOX representative — the branch that cannot exist unpartitioned.
    message({ id: "stray1", from: "stranger@example.invalid", folder: "INBOX", unread: true }),
  ];

  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...rows.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: ISO, entity: m,
    })),
    {
      type: "rule", op: "create", id: "rule_friend", seq: ++seq, updatedAt: ISO,
      entity: rule("friend@example.invalid"),
    } as SyncChange,
    {
      type: "rule", op: "create", id: "rule_ruled", seq: ++seq, updatedAt: ISO,
      entity: rule("ruled@example.invalid"),
    } as SyncChange,
  ]);

  return new OhmailEngine({
    store,
    adapter: {
      // Nothing to fetch: this mirror is the mailbox. The shell's scheduler still drains once.
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: ISO,
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
}

const rowIds = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(".row[data-id]")].map((n) => n.getAttribute("data-id") ?? "");

describe("a standalone install partitions its own mirror", () => {
  beforeEach(() => {
    installShellEnv();
    // AFTER `installShellEnv`, and BEFORE the first `mountShell` — which is where `api-client` is
    // first imported and `API_BASE` is read. The fixture pins `/api` at module load for every
    // other caller; this is the one that must not have a server.
    process.env.NEXT_PUBLIC_API_BASE = "";
  });
  afterEach(async () => {
    await teardownShellEnv();
    process.env.NEXT_PUBLIC_API_BASE = "/api";
  });

  /**
   * A mailbox row is passed although the desktop passes none: it settles the sync strip so the
   * piles render their contents rather than their bootstrapping state. Nothing under test here
   * reads it.
   */
  const mount = async (): Promise<HTMLElement> => {
    const engine = await localEngine();
    const c = await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
    await tick(0);
    return c;
  };

  it("has a History pile, and the dormant sender is in it", async () => {
    const c = await mount();

    await goTo("history");
    // The pile that did not exist on this tier at all. `consentView.history` is its only source.
    expect(rowIds(c)).toContain("dorm1");
  });

  it("asks about the ACTIVE undecided senders, and nobody else", async () => {
    const c = await mount();
    await goTo("screener");

    const ids = rowIds(c);
    expect(ids).toContain("loud1");
    expect(ids).toContain("fresh1");

    // Dormant ⇒ History's business. Unpartitioned this row was in the queue, and so was every
    // other stranger a backfill had ever filed there.
    expect(ids).not.toContain("dorm1");
    // Already consented ⇒ the decision exists; asking again is asking twice.
    expect(ids).not.toContain("known1");
  });

  it("mints the past-the-gate row (#116) that only a partition can produce", async () => {
    const c = await mount();
    await goTo("screener");

    // `stranger@`'s mail is physically in the INBOX. Over the raw mirror `screenerSegments`
    // never sees it — it groups by folder — so this row exists only because the cutline
    // presented it at the gate. Its decision routes past the gate as a rule.
    expect(rowIds(c)).toContain("stray1");
  });

  it("keeps the consented sender's RETIRED Screener-folder backlog at the gate", async () => {
    // INVERTED by ARCH-R902: this pinned the backlog in the Ohbox with nothing moved;
    // it stays at the gate until it is moved, and a decided sender is not asked about again.
    const c = await mount();

    await goTo("ohbox");
    expect(rowIds(c)).not.toContain("known1");
    await goTo("screener");
    expect(rowIds(c)).not.toContain("known1");
  });

  /**
   * A RULE IS NOT A MOVE, AND ON THIS TIER NOBODY ELSE IS LOOKING.
   *
   * `ruled@`'s mail is at the gate and their rule points at the INBOX. The partition used to
   * present it in the Ohbox, so the install's own Screener never asked — and on a standalone
   * install there is no server queue to correct it. The mail stays at the gate for ever and the
   * surface says nothing is waiting.
   */
  it("asks about a RULED sender whose mail the gate is still holding", async () => {
    const c = await mount();
    await goTo("screener");
    expect(rowIds(c)).toContain("ruled1");

    await goTo("ohbox");
    expect(rowIds(c)).not.toContain("ruled1");
  });

  it("counts the queue it holds", async () => {
    const c = await mount();
    await goTo("screener");

    // loud@, fresh@, stranger@ and ruled@ (a rule that has not moved the mail). dorm@ (History)
    // and friend@ (consented AND retired) are excluded, and five messages sit in the Screener
    // FOLDER — the number a person is shown must be the one they can act on.
    expect(textOf(c)).toContain("4 first-time senders waiting");
  });
});
