/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shellFrameOf } from "./source-anchor.js";
import {
  ISO, act, answerStoreWith, answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv,
  textOf, tick,
} from "./fixtures/live-walk-shell";

/**
 * HISTORY — every message the account owns, newest first (ARCHIVE-024), and the claims that make
 * it honest:
 *
 *   1. it is REACHABLE, and the rail entry carries no count — ever;
 *   2. it lists everything the store holds, whatever pile the partition puts a message in;
 *   3. a message in it says where it actually is on the mail server;
 *   4. the partition still decides the PILES: a stranger's row on a consented thread stays out of
 *      the Ohbox and its conversation until the account answers — and reads whole from History.
 *
 * ── WHY THE FIXTURE LOOKS LIKE THIS ───────────────────────────────────────────────────────
 *
 * Every message is in the INBOX physically, because that is the whole point: nothing moved.
 * What separates them is the sender and the clock. `old@` wrote once, long ago, and was read —
 * nobody ever decided about them, so their mail presents in History. `friend@` has a rule, so
 * their equally old mail presents in the Ohbox from the same INBOX. `loud@` is undecided but
 * UNREAD, so they are active and their mail is a Screener row rather than History.
 *
 * The dates are absolute rather than relative to `Date.now()`: the shell pins its clock to
 * `ISO`, and a fixture computing "400 days ago" from the real clock would drift past the
 * window on a machine whose date is wrong and fail for a reason that is not the subject.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** ISO is 2026-08-04; the dormancy window is 60 days. */
const LONG_AGO = "2024-01-11T09:00:00.000Z";

const message = (o: {
  id: string; from: string; folder?: string; unread?: boolean; date?: string; threadId?: string;
  subject?: string;
  /** Recipients. On a row under a Sent path these are the account's own record of who it wrote to. */
  to?: string[];
}, seq: number) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: o.threadId ?? null, messageIdHeader: null,
    subject: o.subject ?? `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: (o.to ?? []).map((address) => ({ name: null, address })), cc: [],
    date: o.date ?? LONG_AGO, folder: o.folder ?? "INBOX",
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

const worldWith = (extra: ReturnType<typeof message>[]): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          // Dormant + undecided + read ⇒ History. Physically in the INBOX, and stays there.
          message({ id: "hist1", from: "old@example.invalid" }, 1),
          message({ id: "hist2", from: "older@example.invalid" }, 2),
          // Undecided but UNREAD ⇒ active ⇒ the Screener demands a decision, however old it is.
          message({ id: "loud1", from: "loud@example.invalid", unread: true }, 3),
          // Consented ⇒ the Ohbox, from the same folder, with nothing moved.
          message({ id: "ohb1", from: "friend@example.invalid" }, 4),
          rule("friend@example.invalid", 5),
          // A thread with one consented participant and one nobody ever screened. `quiet@` is
          // joined to it by a header they wrote themselves, and the account has not answered.
          message({ id: "thr-friend", from: "friend@example.invalid", threadId: "t1", subject: "the roof" }, 6),
          message({ id: "thr-stranger", from: "quiet@example.invalid", threadId: "t1", subject: "the roof" }, 7),
          ...extra,
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c1", hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/**
 * THE SAME WORLD PLUS OUR OWN REPLY on `t1`, naming `quiet@` — a row in the mailbox's Sent
 * folder, which is what makes it the account's own outbound rather than a claim about it.
 * Answered, the thread rescue fires and `thr-stranger` leaves History.
 */
const world = (): Response => worldWith([]);

const answeredWorld = (): Response =>
  worldWith([
    message({
      id: "mine", from: "walker@example.invalid", folder: "Sent", threadId: "t1",
      subject: "the roof", to: ["friend@example.invalid", "quiet@example.invalid"],
    }, 8),
  ]);

const rowIds = (c: HTMLElement): string[] =>
  [...c.querySelectorAll(":is(.row, [role=option])[data-id]")].map((n) => n.getAttribute("data-id") ?? "");

describe("History", () => {
  beforeEach(() => {
    installShellEnv();
    answerSyncWith(world);
  });
  afterEach(teardownShellEnv);

  it("lists every message the store holds — the partition decides the piles, not History", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");
    await tick(0);

    const ids = rowIds(c);
    // The dormant, the unread, the consented and both halves of the thread: everything owned.
    for (const id of ["hist1", "hist2", "loud1", "ohb1", "thr-friend", "thr-stranger"]) expect(ids).toContain(id);
    // …and the count is the store's own.
    expect(c.querySelector(".view-history .meta")?.textContent).toBe("6 messages");
  });

  it("says what it is, above the list, every time — not as a dismissible tip", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    expect(textOf(c)).toContain("Every message you own, newest first");
    // …and it says the mail has not moved, which is the claim somebody would otherwise have
    // to take on trust from a view named after a place that does not exist on their server.
    expect(textOf(c)).toContain("still where your mail server keeps it");
  });

  it("a row names the folder the message is REALLY in", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    // Not "Ohbox", which is what `placeLabel(m.folder)` would have said for a message whose
    // folder is INBOX. History is a presentation and the badge is the server's own answer.
    const row = c.querySelector(':is(.row, [role=option])[data-id="hist1"]');
    expect(row?.textContent ?? "").toContain("INBOX");
  });

  /**
   * A HEADER IS NOT AN ADMISSION — not to the pile, and not to the conversation.
   *
   * `threadId` is the header chain, so a stranger naming a Message-ID this mailbox holds joins
   * the conversation by their own writing. Rescuing them out of History for that would let a
   * header skip the first-contact decision the Screener exists to ask for, so the rescue needs
   * the account's OWN outbound on the thread to name them (`consent-cutline.ts`, and the rule
   * in `@trafficflow/core/sender-headers`). Until it does, their row waits in History.
   *
   * The pane reads the PRESENTED mirror (`conversation-on-screen.ts`), as the phone does, so the
   * conversation opened from the Ohbox is the consented half alone; opened from History, where the
   * stranger's row is, it reads whole. A message stands in a conversation by its place, never by a
   * header another sender wrote (ruled 2026-10-05; until then this pane read the raw mirror).
   */
  it("an unanswered stranger's row stays out of the Ohbox and its conversation, and reads whole from History", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");
    await tick(0);

    expect(rowIds(c)).toContain("thr-stranger");

    await goTo("ohbox");
    expect(rowIds(c), "an uncorroborated join reached the consented pile").not.toContain("thr-stranger");

    // The consented half's row IS there, and opening it renders the whole conversation.
    const row = c.querySelector(':is(.row, [role=option])[data-id="thr-friend"]') as HTMLElement | null;
    expect(row, "the consented half of the thread is not in the Ohbox").toBeTruthy();
    await act(async () => {
      row!.click();
      await Promise.resolve();
    });
    await tick(0);

    const pane = c.querySelector(".view-ohbox .read-col")?.textContent ?? "";
    expect(pane, "the consented half is not in the pane").toContain("Sender thr-friend");
    expect(pane, "a header put the stranger's message in the Ohbox's conversation").not.toContain("Sender thr-stranger");

    await goTo("history");
    await tick(0);
    const held = c.querySelector(':is(.row, [role=option])[data-id="thr-stranger"]') as HTMLElement | null;
    expect(held, "the stranger's row is not in History").toBeTruthy();
    await act(async () => { held!.click(); await Promise.resolve(); });
    await tick(0);
    await tick(0);
    const col = c.querySelector(".view-history .read-col")?.textContent ?? "";
    expect(col, "the stranger's message is missing from its own conversation").toContain("Sender thr-stranger");
    expect(col, "opened from History, the conversation is not whole").toContain("Sender thr-friend");
  });

  /**
   * THE POSITIVE CONTROL for the line above: once the account has written on the thread and
   * named the sender, the record corroborating them exists and the rescue fires. Without this
   * case the refusal above passes for a rescue that never works at all.
   */
  it("…and our own reply on the thread brings it into the Ohbox, while History keeps it", async () => {
    answerSyncWith(answeredWorld);
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("ohbox");
    expect(rowIds(c), "the rescue did not reach the consented pile").toContain("thr-stranger");
    await goTo("history");
    await tick(0);
    const ids = rowIds(c);
    expect(ids).toContain("thr-stranger");
    expect(ids).toContain("hist1");
  });

  it("THE FIRST MESSAGE: a row only the store holds opens, and its body is read and rendered", async () => {
    const first = message({ id: "first-ever", from: "origin@example.invalid", date: "2011-06-01T08:00:00.000Z", subject: "the very first message" }, 99).entity;
    answerStoreWith([first], { "first-ever": "Hello from two thousand eleven — the whole text of it." });
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");
    await tick(0);
    // The last slot of the timeline is the account's first message, which the mirror never held.
    const rail = [...c.querySelectorAll(".history-rail-item")] as HTMLButtonElement[];
    if (rail.length > 1) await act(async () => { rail[rail.length - 1]!.click(); await Promise.resolve(); });
    await tick(0);
    const row = c.querySelector(':is(.row, [role=option])[data-id="first-ever"]') as HTMLElement | null;
    expect(row, "the first message is not in History").toBeTruthy();
    await act(async () => { row!.click(); await Promise.resolve(); });
    await tick(0);
    await tick(0);
    const col = c.querySelector(".view-history .read-col")?.textContent ?? "";
    expect(col).toContain("the very first message");
    expect(col).toContain("Hello from two thousand eleven");
  });

  it("opening a message keeps you in History and shows it in full", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    const row = c.querySelector(':is(.row, [role=option])[data-id="hist1"]') as HTMLElement | null;
    expect(row).toBeTruthy();
    await act(async () => {
      row!.click();
      await Promise.resolve();
    });
    await tick(0);

    // The reader is a message and not a pile, which is what lets a message belonging to no
    // pile be opened at all. `openMessage` would have navigated to the Ohbox — where this
    // message deliberately does not appear — and selected a row that is not in the list. The
    // address stays on History and names the letter, so a reload reopens it.
    expect(window.location.hash).toBe("#/history/m/hist1");
    expect(textOf(c)).toContain("subject of hist1");
  });

  /**
   * THE READING LAYOUT — the Ohbox's, and it is no longer a choice.
   *
   * There was a `List` / `Split` segmented control here, defaulting to a solo centred list that
   * raised a reader sheet per message. It is gone with the solo mode it selected. Two things
   * only the rendered surface can be wrong about, and the second is what makes the deletion a
   * DELETION rather than a default change: the control is not on screen at all, so the dead
   * mode cannot be re-entered by anything that survived.
   */
  it("is the two-pane layout on arrival, with no mode to pick", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    const view = c.querySelector(".view-history")!;
    // Mutation watched: restore `layout === "split" ? … : "view center"` and this goes red.
    expect(view.classList.contains("split")).toBe(true);
    expect(view.classList.contains("center")).toBe(false);
    expect(c.querySelector(".view-history .read-col"), "no reading column beside the list")
      .not.toBeNull();

    // The control, and every path back to the mode it selected, are gone.
    const labels = [...c.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(labels, "the layout toggle is still on screen").not.toContain("Split");
    expect(labels, "the layout toggle is still on screen").not.toContain("List");
    expect(c.querySelector(".view-mode"), "the toggle's slot outlived the toggle").toBeNull();
  });

  it("reads a message IN THE COLUMN, in place — never a navigation, never a sheet-only", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    const row = c.querySelector(':is(.row, [role=option])[data-id="hist2"]') as HTMLElement | null;
    await act(async () => {
      row!.click();
      await Promise.resolve();
    });
    await tick(0);

    // The message is read where it lives — in the column, on the History route. Not `openMessage`,
    // which would have navigated to the Ohbox and dropped the reader onto a row that is not there.
    // The address names the letter on the History route.
    expect(window.location.hash).toBe("#/history/m/hist2");
    expect(c.querySelector(".view-history .read-col")!.textContent ?? "").toContain("subject of hist2");
  });

  /**
   * THE BADGE, ASSERTED ON THE SOURCE.
   *
   * A count is a rendering decision made in `railGroups`, and the honest way to pin its absence
   * is to read the object that declares it. A DOM assertion would pass for the wrong reason on
   * an account whose History happens to be empty — which is every fixture that forgets to seed
   * one — and that is exactly the vacuous-green shape this suite has been bitten by before.
   *
   * Mutation watched: adding `count: history.length` to the History rail item fails this.
   */
  it("the rail entry declares NO count — a place that cannot demand attention shows no number", () => {
    /* The rail and the pile list left `AppShell.tsx` for `shell-keys.tsx` (ARCH-022 L6), asked
       of the frame that declares them rather than of a path. */
    const src = shellFrameOf("numberNav").source;
    const item = /\{\s*id:\s*"history"[^}]*\}/.exec(src)?.[0];
    expect(item, "the History rail item moved or was renamed").toBeTruthy();
    expect(item).not.toContain("count");
  });

  /** …and it is not one of the numbered piles, so `1`…`9` still address the piles they always did. */
  it("is not a numbered pile", () => {
    const src = shellFrameOf("numberNav").source;
    const piles = /const PILE_IDS: string\[\] = \[[^\]]*\]/.exec(src)?.[0] ?? "";
    expect(piles).toBeTruthy();
    expect(piles).not.toContain("history");
  });
});
