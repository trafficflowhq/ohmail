/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { within } from "@testing-library/react";
import { readingColumn, seatedList } from "./ohbox/_finders.js";
import {
  ISO, act, answerStoreWith, answerSyncWith, goTo, installShellEnv, liveAccountResponse, mailbox, mountShell, teardownShellEnv,
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
  [...c.querySelectorAll('[role="option"][data-id]')].map((n) => n.getAttribute("data-id") ?? "");

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
    expect(seatedList(c)?.querySelector(".oh-listhead-count")?.textContent).toBe("6 messages");
  });

  it("shows History without a standing explanation above the list", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    const list = seatedList(c)!;
    expect(within(list).getByRole("heading", { name: "History" })).toBeTruthy();
    expect(within(list).getByRole("listbox", { name: "History" })).toBeTruthy();
    expect(textOf(list)).not.toContain("Every message you own, newest first");
    expect(textOf(list)).not.toContain("still where your mail server keeps it");
  });

  it("a row names the physical folder using its place label", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    // The place badge translates the physical INBOX to the name used in the app.
    const row = c.querySelector('[role="option"][data-id="hist1"]');
    expect(row?.querySelector(".oh-where")?.textContent).toBe("Ohbox");
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
    const row = c.querySelector('[role="option"][data-id="thr-friend"]') as HTMLElement | null;
    expect(row, "the consented half of the thread is not in the Ohbox").toBeTruthy();
    await act(async () => {
      row!.click();
      await Promise.resolve();
    });
    await tick(0);

    const pane = readingColumn(c)?.textContent ?? "";
    expect(pane, "the consented half is not in the pane").toContain("Sender thr-friend");
    expect(pane, "a header put the stranger's message in the Ohbox's conversation").not.toContain("Sender thr-stranger");

    await goTo("history");
    await tick(0);
    const held = c.querySelector('[role="option"][data-id="thr-stranger"]') as HTMLElement | null;
    expect(held, "the stranger's row is not in History").toBeTruthy();
    await act(async () => { held!.click(); await Promise.resolve(); });
    await tick(0);
    await tick(0);
    const col = readingColumn(c)?.textContent ?? "";
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
    const fetchMail = globalThis.fetch;
    const lookups: string[] = [];
    globalThis.fetch = (input, init) => {
      if ((init?.method ?? "GET") === "GET" && /\/messages\/first-ever(?:\?|$)/.test(String(input))) {
        lookups.push(first.id);
        return Promise.resolve(liveAccountResponse(Response.json(first)));
      }
      return fetchMail(input, init);
    };
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");
    await tick(0);
    // The last slot of the timeline is the account's first message, which the mirror never held.
    const rail = within(c).queryByRole("navigation", { name: "Month" });
    const oldest = rail && within(rail).queryAllByRole("button").at(-1);
    if (oldest) await act(async () => { oldest.click(); await Promise.resolve(); });
    await tick(0);
    const row = c.querySelector('[role="option"][data-id="first-ever"]') as HTMLElement | null;
    expect(row, "the first message is not in History").toBeTruthy();
    await act(async () => { row!.click(); await Promise.resolve(); });
    await tick(0);
    await tick(0);
    const col = readingColumn(c)?.textContent ?? "";
    expect(col).toContain("the very first message");
    expect(lookups).toEqual(["first-ever"]);
    expect(col).toContain("Hello from two thousand eleven");
  });

  it("opening a message keeps you in History and shows it in full", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    const row = c.querySelector('[role="option"][data-id="hist1"]') as HTMLElement | null;
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

    expect(seatedList(c)).not.toBeNull();
    expect(readingColumn(c), "no reading column beside the list").not.toBeNull();
    expect(within(c).queryByRole("dialog", { name: "Reading" })).toBeNull();
    expect(within(c).queryByRole("button", { name: /^Split$/ })).toBeNull();
    /* The head's one "List" button is the list's own menu (its verbs), never a layout mode. */
    const lists = within(c).queryAllByRole("button", { name: /^List$/ });
    expect(lists.filter((b) => b.getAttribute("aria-haspopup") !== "menu"), "no List mode beside Split").toEqual([]);
  });

  it("reads a message IN THE COLUMN, in place — never a navigation, never a sheet-only", async () => {
    const c = await mountShell([mailbox({ lastSyncAt: ISO })]);
    await tick(0);
    await goTo("history");

    const row = c.querySelector('[role="option"][data-id="hist2"]') as HTMLElement | null;
    await act(async () => {
      row!.click();
      await Promise.resolve();
    });
    await tick(0);

    // The message is read where it lives — in the column, on the History route. Not `openMessage`,
    // which would have navigated to the Ohbox and dropped the reader onto a row that is not there.
    // The address names the letter on the History route.
    expect(window.location.hash).toBe("#/history/m/hist2");
    expect(readingColumn(c)!.textContent ?? "").toContain("subject of hist2");
  });

  it("the rail entry declares NO count — a place that cannot demand attention shows no number", () => {
    const source = read("../../../packages/app/src/history/place.ts");
    const rail = /rail:\s*\{([^}]+)\}/.exec(source)?.[1];
    expect(rail, "the History rail registration").toBeTruthy();
    expect(rail).not.toMatch(/\b(?:count|useCount)\b/);
  });

  it("is not a numbered pile", () => {
    const place = read("../../../packages/app/src/history/place.ts");
    const group = /rail:\s*\{[^}]*\bgroup:\s*"([^"]+)"/.exec(place)?.[1];
    expect(group, "the History rail group").toBeTruthy();
    const source = read("../../../packages/app/src/frame/chords.tsx");
    const groups = /const NUMBERED:[^=]*=\s*\[([^\]]+)\]/.exec(source)?.[1];
    expect(groups, "the frame's numbered rail groups").toBeTruthy();
    expect(groups).not.toContain(`"${group}"`);
  });
});
